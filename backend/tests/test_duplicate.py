"""Spec §4.2 and §4.3 Duplicate: RTN-3 (duplicate a Routine to start a new block) and DAY-4
(duplicate a Day into this or another Routine)."""

import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

TODAY = dt.datetime.now(dt.UTC).date()


def ok(res: httpx2.Response, code: int = 200) -> Any:
    assert res.status_code == code, res.json()
    return res.json()


class Routine:
    """A Routine with Days, each with one Turn and the given Lines (Exercise names), in order."""

    def __init__(self, client: TestClient, name: str = "PPL", **days: list[str]) -> None:
        self.client = client
        self.id: int = ok(client.post("/api/routines", json={"name": name}), 201)["id"]
        self.day: dict[str, int] = {}
        for day, lines in days.items():
            self.day[day] = ok(client.post(f"/api/routines/{self.id}/days", json={"name": day}), 201)["id"]
            for line in lines:
                ok(client.post(f"/api/days/{self.day[day]}/lines", json={"name": line}), 201)


def detail(client: TestClient, routine_id: int) -> dict[str, Any]:
    body: dict[str, Any] = ok(client.get(f"/api/routines/{routine_id}"))
    return body


def shape(body: dict[str, Any]) -> tuple[list[tuple[str, list[str]]], list[str]]:
    """A Routine detail as its Days (name, Exercise names) and its rotation (Day names)."""
    names = {d["id"]: d["name"] for d in body["days"]}
    days = [(d["name"], [line["exercise"]["name"] for line in d["lines"]]) for d in body["days"]]
    return days, [names[t["day_id"]] for t in body["rotation"]]


def duplicate_routine(client: TestClient, routine_id: int, name: str) -> httpx2.Response:
    return client.post(f"/api/routines/{routine_id}/duplicate", json={"name": name})


def duplicate_day(client: TestClient, day_id: int, routine_id: int, name: str) -> httpx2.Response:
    return client.post(f"/api/days/{day_id}/duplicate", json={"routine_id": routine_id, "name": name})


def refused(res: httpx2.Response, status: int, code: str) -> str:
    assert res.status_code == status, res.json()
    assert res.json()["code"] == code
    message: str = res.json()["message"]
    return message


# Duplicate a Routine (RTN-3)


def test_duplicate_routine_copies_days_lines_and_turns_in_order(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench", "Dips", "Bench"], Pull=["Rows"], Legs=[], Arms=["Curls"])
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": ppl.day["Push"]}))
    ok(client.post(f"/api/days/{ppl.day['Arms']}/drop"))  # off the rotation, still copied
    turn_ids = [t["id"] for t in detail(client, ppl.id)["rotation"]]
    ok(client.put(f"/api/routines/{ppl.id}/turns", json={"turn_ids": list(reversed(turn_ids))}))

    copy = ok(duplicate_routine(client, ppl.id, "  PPL   block 2 "), 201)

    assert copy["name"] == "PPL block 2"
    assert copy["engaged"] is False
    assert shape(copy) == shape(detail(client, ppl.id))
    assert shape(copy) == (
        [("Push", ["Bench", "Dips", "Bench"]), ("Pull", ["Rows"]), ("Legs", []), ("Arms", ["Curls"])],
        ["Push", "Legs", "Pull", "Push"],
    )
    assert detail(client, copy["id"]) == copy


def test_duplicate_routine_shares_exercises_but_no_rows(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    original = detail(client, ppl.id)
    copy = ok(duplicate_routine(client, ppl.id, "PPL 2"), 201)
    assert copy["id"] != ppl.id
    assert copy["days"][0]["id"] != original["days"][0]["id"]
    assert copy["days"][0]["lines"][0]["id"] != original["days"][0]["lines"][0]["id"]
    assert copy["days"][0]["lines"][0]["exercise"] == original["days"][0]["lines"][0]["exercise"]
    assert copy["rotation"][0]["id"] != original["rotation"][0]["id"]
    assert len(ok(client.get("/api/exercises"))) == 1


def test_duplicate_routine_keeps_no_link_back(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    copy = ok(duplicate_routine(client, ppl.id, "PPL 2"), 201)
    push = ppl.day["Push"]
    ok(client.post(f"/api/days/{push}/lines", json={"name": "Dips"}), 201)
    ok(client.patch(f"/api/days/{push}", json={"name": "Chest"}))
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": push}))
    assert shape(detail(client, copy["id"])) == ([("Push", ["Bench"])], ["Push"])


def test_duplicate_routine_copies_no_sessions_or_skips_and_starts_at_the_first_turn(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=["Rows"])
    up = ok(client.get("/api/up-next"))
    skip = {"routine_id": ppl.id, "turn_id": up["suggestion"]["turn_id"], "date": str(TODAY), "today": str(TODAY)}
    ok(client.post("/api/skips", json=skip), 201)
    copy = ok(duplicate_routine(client, ppl.id, "PPL 2"), 201)
    assert copy["next_turn_id"] == copy["rotation"][0]["id"]
    ok(client.post(f"/api/routines/{copy['id']}/engage"))
    up = ok(client.get("/api/up-next"))
    assert up["suggestion"]["day_name"] == "Push"
    assert up["last_skip"] is None
    history = ok(client.get("/api/history"))
    assert all(entry["routine"]["id"] == ppl.id for entry in history)


def test_duplicate_routine_with_no_days(client: TestClient) -> None:
    empty = Routine(client, "Empty")
    copy = ok(duplicate_routine(client, empty.id, "Empty 2"), 201)
    assert (copy["days"], copy["rotation"], copy["next_turn_id"]) == ([], [], None)


@pytest.mark.parametrize("name", ["ppl", " PPL ", "Upper   lower"])
def test_duplicate_routine_needs_a_unique_name(client: TestClient, name: str) -> None:
    ppl = Routine(client, Push=[])
    Routine(client, "Upper Lower")
    refused(duplicate_routine(client, ppl.id, name), 409, "name_taken")
    assert len(ok(client.get("/api/routines"))) == 2


def test_duplicate_routine_needs_a_name(client: TestClient) -> None:
    ppl = Routine(client)
    refused(duplicate_routine(client, ppl.id, "   "), 422, "name_empty")


@pytest.mark.parametrize("routine_id", [999, 0, 2**31])
def test_duplicating_an_unknown_routine_is_refused(client: TestClient, routine_id: int) -> None:
    refused(duplicate_routine(client, routine_id, "Copy"), 404, "not_found")


def test_concurrent_duplicates_to_one_name_make_one_routine(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    with ThreadPoolExecutor(4) as pool:
        codes = sorted(pool.map(lambda _: duplicate_routine(client, ppl.id, "PPL 2").status_code, range(4)))
    assert codes == [201, 409, 409, 409]
    assert [r["name"] for r in ok(client.get("/api/routines"))] == ["PPL", "PPL 2"]


# Duplicate a Day (DAY-4)


def test_duplicate_day_into_the_same_routine(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench", "Dips", "Bench"], Pull=["Rows"])
    res = ok(duplicate_day(client, ppl.day["Push"], ppl.id, " Push   heavy "), 201)
    assert shape(res) == (
        [("Push", ["Bench", "Dips", "Bench"]), ("Pull", ["Rows"]), ("Push heavy", ["Bench", "Dips", "Bench"])],
        ["Push", "Pull", "Push heavy"],
    )
    assert res == detail(client, ppl.id)


def test_duplicate_day_into_another_routine(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench", "Dips"])
    ul = Routine(client, "Upper Lower", Upper=["Rows"], Lower=["Squat"])
    res = ok(duplicate_day(client, ppl.day["Push"], ul.id, "Push"), 201)
    assert res["id"] == ul.id
    assert shape(res) == (
        [("Upper", ["Rows"]), ("Lower", ["Squat"]), ("Push", ["Bench", "Dips"])],
        ["Upper", "Lower", "Push"],
    )
    assert shape(detail(client, ppl.id)) == ([("Push", ["Bench", "Dips"])], ["Push"])


def test_duplicate_day_gets_one_turn_however_many_the_original_has(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=[])
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": ppl.day["Push"]}))
    res = ok(duplicate_day(client, ppl.day["Push"], ppl.id, "Push 2"), 201)
    assert shape(res)[1] == ["Push", "Pull", "Push", "Push 2"]


def test_duplicate_of_a_dropped_day_is_on_the_rotation(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=[])
    ok(client.post(f"/api/days/{ppl.day['Push']}/drop"))
    res = ok(duplicate_day(client, ppl.day["Push"], ppl.id, "Push 2"), 201)
    assert shape(res)[1] == ["Pull", "Push 2"]


def test_duplicate_day_keeps_no_link_back(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    res = ok(duplicate_day(client, ppl.day["Push"], ppl.id, "Push 2"), 201)
    copy = res["days"][1]
    assert copy["lines"][0]["id"] != res["days"][0]["lines"][0]["id"]
    ok(client.post(f"/api/days/{ppl.day['Push']}/lines", json={"name": "Dips"}), 201)
    assert [line["exercise"]["name"] for line in ok(client.get(f"/api/days/{copy['id']}"))["lines"]] == ["Bench"]


def test_duplicate_day_keeps_a_retired_exercises_line(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    bench = ok(client.get("/api/exercises"))[0]["id"]
    ok(client.patch(f"/api/exercises/{bench}", json={"retired": True}))
    res = ok(duplicate_day(client, ppl.day["Push"], ppl.id, "Push 2"), 201)
    assert shape(res)[0][1] == ("Push 2", ["Bench"])


@pytest.mark.parametrize("name", ["push", " Pull "])
def test_duplicate_day_needs_a_name_unique_in_the_target(client: TestClient, name: str) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=[])
    refused(duplicate_day(client, ppl.day["Push"], ppl.id, name), 409, "name_taken")
    assert len(detail(client, ppl.id)["days"]) == 2


def test_duplicate_day_name_collision_names_the_target_routine(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    ul = Routine(client, "Upper Lower", push=[])
    message = refused(duplicate_day(client, ppl.day["Push"], ul.id, "Push"), 409, "name_taken")
    assert message == "There is already a Day called “push” in “Upper Lower”."


def test_duplicate_day_needs_a_name(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    refused(duplicate_day(client, ppl.day["Push"], ppl.id, ""), 422, "name_empty")


def test_concurrent_duplicates_of_a_day_to_one_name_make_one_day(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    with ThreadPoolExecutor(4) as pool:
        codes = sorted(pool.map(lambda _: duplicate_day(client, ppl.day["Push"], ppl.id, "B").status_code, range(4)))
    assert codes == [201, 409, 409, 409]
    assert shape(detail(client, ppl.id)) == ([("Push", ["Bench"]), ("B", ["Bench"])], ["Push", "B"])


@pytest.mark.parametrize("day_id", [999, 0, 2**31])
def test_duplicating_an_unknown_day_is_refused(client: TestClient, day_id: int) -> None:
    ppl = Routine(client)
    refused(duplicate_day(client, day_id, ppl.id, "Copy"), 404, "not_found")


@pytest.mark.parametrize("routine_id", [999, 0, 2**31])
def test_duplicating_a_day_into_an_unknown_routine_is_refused(client: TestClient, routine_id: int) -> None:
    ppl = Routine(client, Push=[])
    refused(duplicate_day(client, ppl.day["Push"], routine_id, "Copy"), 404, "not_found")
