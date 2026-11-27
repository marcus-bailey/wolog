"""Spec §4.3 and §4.1 on a Line, DAY-1 (create, rename), DAY-2, LIB-1: Days and their Lines."""

from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError


def routine(client: TestClient, name: str = "PPL") -> int:
    res = client.post("/api/routines", json={"name": name})
    assert res.status_code == 201, res.json()
    routine_id: int = res.json()["id"]
    return routine_id


def day(client: TestClient, routine_id: int, name: str) -> dict[str, Any]:
    res = client.post(f"/api/routines/{routine_id}/days", json={"name": name})
    assert res.status_code == 201, res.json()
    body: dict[str, Any] = res.json()
    return body


def add_line(client: TestClient, day_id: int, name: str) -> httpx2.Response:
    return client.post(f"/api/days/{day_id}/lines", json={"name": name})


def line_names(body: dict[str, Any]) -> list[str]:
    return [line["exercise"]["name"] for line in body["lines"]]


def detail(client: TestClient, routine_id: int) -> dict[str, Any]:
    res = client.get(f"/api/routines/{routine_id}")
    assert res.status_code == 200, res.json()
    body: dict[str, Any] = res.json()
    return body


def exercise_names(client: TestClient) -> list[str]:
    return [e["name"] for e in client.get("/api/exercises").json()]


# Routine detail


def test_a_new_routine_has_no_days_and_an_empty_rotation(client: TestClient) -> None:
    ppl = routine(client)
    assert detail(client, ppl) == {
        "id": ppl,
        "name": "PPL",
        "engaged": True,
        "days": [],
        "rotation": [],
        "next_turn_id": None,
    }


def test_an_unknown_routine_has_no_detail(client: TestClient) -> None:
    for routine_id in (999, 0, 2**31):
        res = client.get(f"/api/routines/{routine_id}")
        assert res.status_code == 404
        assert res.json() == {"code": "not_found", "message": "That Routine no longer exists."}


# Create and rename a Day (DAY-1)


def test_a_day_is_created_with_a_name_and_no_lines(client: TestClient) -> None:
    ppl = routine(client)
    res = client.post(f"/api/routines/{ppl}/days", json={"name": "  Push   A "})
    assert res.status_code == 201
    assert res.json() == {"id": res.json()["id"], "name": "Push A", "lines": []}
    assert detail(client, ppl)["days"] == [res.json()]


def test_a_new_day_gets_one_turn_at_the_end_of_the_rotation(client: TestClient) -> None:
    ppl = routine(client)
    push, pull, legs = (day(client, ppl, n)["id"] for n in ("Push", "Pull", "Legs"))
    rotation = detail(client, ppl)["rotation"]
    assert [t["day_id"] for t in rotation] == [push, pull, legs]
    assert len({t["id"] for t in rotation}) == 3


def test_days_are_listed_in_the_order_they_were_created(client: TestClient) -> None:
    ppl = routine(client)
    for name in ("Push", "Pull", "Legs"):
        day(client, ppl, name)
    assert [d["name"] for d in detail(client, ppl)["days"]] == ["Push", "Pull", "Legs"]


@pytest.mark.parametrize("taken", ["Push", "push", "  PUSH "])
def test_a_day_name_is_unique_within_its_routine(client: TestClient, taken: str) -> None:
    ppl = routine(client)
    day(client, ppl, "Push")
    res = client.post(f"/api/routines/{ppl}/days", json={"name": taken})
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already a Day called “Push” in this Routine."}
    assert [d["name"] for d in detail(client, ppl)["days"]] == ["Push"]
    assert len(detail(client, ppl)["rotation"]) == 1


def test_another_routine_may_have_a_day_of_the_same_name(client: TestClient) -> None:
    ppl, ul = routine(client, "PPL"), routine(client, "Upper Lower")
    day(client, ppl, "Push")
    assert day(client, ul, "push")["name"] == "push"


@pytest.mark.parametrize("raw", ["", "   "])
def test_a_day_needs_a_name(client: TestClient, raw: str) -> None:
    ppl = routine(client)
    res = client.post(f"/api/routines/{ppl}/days", json={"name": raw})
    assert res.status_code == 422
    assert res.json() == {"code": "name_empty", "message": "A Day needs a name."}
    assert detail(client, ppl)["days"] == []


def test_a_day_in_an_unknown_routine_is_refused(client: TestClient) -> None:
    res = client.post("/api/routines/999/days", json={"name": "Push"})
    assert res.status_code == 404
    assert res.json()["code"] == "not_found"


def test_rename_is_a_label_change(client: TestClient) -> None:
    ppl = routine(client)
    push = day(client, ppl, "Push")
    add_line(client, push["id"], "Bench Press")
    res = client.patch(f"/api/days/{push['id']}", json={"name": " Push  A "})
    assert res.status_code == 200
    assert res.json()["id"] == push["id"]
    assert res.json()["name"] == "Push A"
    assert line_names(res.json()) == ["Bench Press"]
    assert [t["day_id"] for t in detail(client, ppl)["rotation"]] == [push["id"]]


def test_a_rename_may_change_only_the_case_of_its_own_name(client: TestClient) -> None:
    push = day(client, routine(client), "push")
    assert client.patch(f"/api/days/{push['id']}", json={"name": "Push"}).json()["name"] == "Push"


def test_a_rename_colliding_within_the_routine_is_refused(client: TestClient) -> None:
    ppl = routine(client)
    day(client, ppl, "Pull")
    push = day(client, ppl, "Push")
    res = client.patch(f"/api/days/{push['id']}", json={"name": "PULL"})
    assert res.status_code == 409
    assert res.json()["message"] == "There is already a Day called “Pull” in this Routine."
    assert client.patch(f"/api/days/{push['id']}", json={"name": " "}).json()["code"] == "name_empty"
    assert [d["name"] for d in detail(client, ppl)["days"]] == ["Pull", "Push"]


def test_renaming_an_unknown_day_is_refused(client: TestClient) -> None:
    res = client.patch("/api/days/999", json={"name": "Push"})
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Day no longer exists."}


def test_concurrent_creates_of_one_day_name_make_one_day(client: TestClient) -> None:
    ppl = routine(client)
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: client.post(f"/api/routines/{ppl}/days", json={"name": "Push"}), range(6)))
    assert sorted(r.status_code for r in results) == [201] + [409] * 5


def test_concurrent_creates_give_each_day_its_own_turn(client: TestClient) -> None:
    ppl = routine(client)
    with ThreadPoolExecutor(6) as pool:
        list(pool.map(lambda i: day(client, ppl, f"Day {i}"), range(6)))
    body = detail(client, ppl)
    assert sorted(t["day_id"] for t in body["rotation"]) == sorted(d["id"] for d in body["days"])


# Lines: attach or create by name (LIB-1 on a Line)


def test_typing_a_new_name_creates_the_exercise_and_attaches_it(client: TestClient) -> None:
    push = day(client, routine(client), "Push")
    res = add_line(client, push["id"], "  Bench   Press ")
    assert res.status_code == 201
    line = res.json()["lines"][0]
    assert line["exercise"] == {"id": line["exercise"]["id"], "name": "Bench Press", "retired": False}
    assert exercise_names(client) == ["Bench Press"]


def test_typing_a_live_name_attaches_it_and_keeps_its_stored_name(client: TestClient) -> None:
    bench = client.post("/api/exercises", json={"name": "Bench Press"}).json()
    push = day(client, routine(client), "Push")
    res = add_line(client, push["id"], " bench PRESS ")
    assert res.json()["lines"][0]["exercise"] == bench
    assert exercise_names(client) == ["Bench Press"]


def test_typing_a_retired_name_is_refused_and_points_to_it(client: TestClient) -> None:
    squat = client.post("/api/exercises", json={"name": "Squat"}).json()
    client.patch(f"/api/exercises/{squat['id']}", json={"retired": True})
    ppl = routine(client)
    legs = day(client, ppl, "Legs")
    res = add_line(client, legs["id"], "squat")
    assert res.status_code == 409
    assert res.json() == {
        "code": "name_retired",
        "message": "“Squat” is a Retired Exercise. Un-retire it to use it again.",
    }
    assert detail(client, ppl)["days"][0]["lines"] == []


def test_a_line_of_an_exercise_retired_later_stays(client: TestClient) -> None:
    ppl = routine(client)
    legs = day(client, ppl, "Legs")
    squat = add_line(client, legs["id"], "Squat").json()["lines"][0]
    client.patch(f"/api/exercises/{squat['exercise']['id']}", json={"retired": True})
    lines = detail(client, ppl)["days"][0]["lines"]
    assert lines == [{"id": squat["id"], "exercise": {**squat["exercise"], "retired": True}}]


def test_the_same_exercise_may_be_on_several_lines(client: TestClient) -> None:
    push = day(client, routine(client), "Push")
    add_line(client, push["id"], "Bench Press")
    add_line(client, push["id"], "Fly")
    res = add_line(client, push["id"], "bench press")
    assert line_names(res.json()) == ["Bench Press", "Fly", "Bench Press"]
    ids = [line["exercise"]["id"] for line in res.json()["lines"]]
    assert ids[0] == ids[2]
    assert exercise_names(client) == ["Bench Press", "Fly"]


@pytest.mark.parametrize("raw", ["", "  "])
def test_a_line_needs_an_exercise_name(client: TestClient, raw: str) -> None:
    push = day(client, routine(client), "Push")
    res = add_line(client, push["id"], raw)
    assert res.status_code == 422
    assert res.json()["code"] == "name_empty"


def test_a_line_on_an_unknown_day_is_refused_and_creates_no_exercise(client: TestClient) -> None:
    res = add_line(client, 999, "Squat")
    assert res.status_code == 404
    assert res.json()["code"] == "not_found"
    assert exercise_names(client) == []


def test_concurrent_lines_of_one_new_name_share_one_exercise(client: TestClient) -> None:
    ppl = routine(client)
    days = [day(client, ppl, f"Day {i}")["id"] for i in range(6)]
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda d: add_line(client, d, "Squat"), days))
    assert [r.status_code for r in results] == [201] * 6
    assert exercise_names(client) == ["Squat"]


def test_concurrent_lines_on_one_day_each_get_their_own_place(client: TestClient) -> None:
    ppl = routine(client)
    push = day(client, ppl, "Push")
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda i: add_line(client, push["id"], f"E{i}"), range(6)))
    assert [r.status_code for r in results] == [201] * 6
    assert sorted(line_names(detail(client, ppl)["days"][0])) == [f"E{i}" for i in range(6)]


# Reorder and remove Lines (DAY-2)


def lines_of(client: TestClient, *names: str) -> tuple[int, list[int]]:
    push = day(client, routine(client), "Push")
    body: dict[str, Any] = {}
    for name in names:
        body = add_line(client, push["id"], name).json()
    return push["id"], [line["id"] for line in body["lines"]]


def test_lines_are_reordered_to_the_order_given(client: TestClient) -> None:
    day_id, (bench, fly, dip) = lines_of(client, "Bench Press", "Fly", "Dip")
    res = client.put(f"/api/days/{day_id}/lines", json={"line_ids": [fly, bench, dip]})
    assert res.status_code == 200
    assert line_names(res.json()) == ["Fly", "Bench Press", "Dip"]
    assert [line["id"] for line in res.json()["lines"]] == [fly, bench, dip]  # Lines keep their identity
    res = client.put(f"/api/days/{day_id}/lines", json={"line_ids": [dip, bench, fly]})
    assert line_names(res.json()) == ["Dip", "Bench Press", "Fly"]


@pytest.mark.parametrize("order", ["missing", "extra", "repeated", "foreign"])
def test_a_reorder_must_name_every_line_once(client: TestClient, order: str) -> None:
    day_id, (bench, fly) = lines_of(client, "Bench Press", "Fly")
    given = {
        "missing": [fly],
        "extra": [fly, bench, 999],
        "repeated": [fly, fly],
        "foreign": [fly, 999],
    }[order]
    res = client.put(f"/api/days/{day_id}/lines", json={"line_ids": given})
    assert res.status_code == 409
    assert res.json() == {
        "code": "lines_changed",
        "message": "The Day’s Lines changed since you loaded them. Reload and try again.",
    }


def test_a_line_is_removed_and_its_exercise_stays_in_the_library(client: TestClient) -> None:
    day_id, (bench, fly, dip) = lines_of(client, "Bench Press", "Fly", "Dip")
    res = client.delete(f"/api/days/{day_id}/lines/{fly}")
    assert res.status_code == 200
    assert [line["id"] for line in res.json()["lines"]] == [bench, dip]
    assert exercise_names(client) == ["Bench Press", "Dip", "Fly"]
    # positions close up: a later Line goes at the end, and a reorder still works
    res = add_line(client, day_id, "Fly")
    assert line_names(res.json()) == ["Bench Press", "Dip", "Fly"]
    new = res.json()["lines"][2]["id"]
    assert line_names(client.put(f"/api/days/{day_id}/lines", json={"line_ids": [new, dip, bench]}).json()) == [
        "Fly",
        "Dip",
        "Bench Press",
    ]


def test_removing_a_line_not_on_the_day_is_refused(client: TestClient) -> None:
    day_id, (bench,) = lines_of(client, "Bench Press")
    other = day(client, routine(client, "Other"), "Other")
    res = client.delete(f"/api/days/{other['id']}/lines/{bench}")
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Line is no longer on the Day."}
    assert client.delete(f"/api/days/{day_id}/lines/999").status_code == 404
    assert client.delete(f"/api/days/999/lines/{bench}").json()["message"] == "That Day no longer exists."


# Exercise delete and Lines (LIB-4)


def test_an_exercise_on_a_day_line_cannot_be_deleted(client: TestClient) -> None:
    day_id, (bench,) = lines_of(client, "Bench Press")
    exercise_id = client.get("/api/exercises").json()[0]["id"]
    res = client.delete(f"/api/exercises/{exercise_id}")
    assert res.status_code == 409
    assert res.json()["code"] == "exercise_in_use"
    client.delete(f"/api/days/{day_id}/lines/{bench}")
    assert client.delete(f"/api/exercises/{exercise_id}").status_code == 204  # unused again


def test_creating_an_exercise_in_the_library_adds_it_to_no_day(client: TestClient) -> None:
    ppl = routine(client)
    day(client, ppl, "Push")
    client.post("/api/exercises", json={"name": "Bench Press"})
    assert detail(client, ppl)["days"][0]["lines"] == []


# The database, below the API


def test_a_turn_cannot_name_a_day_of_another_routine(client: TestClient, engine: Engine) -> None:
    ppl, ul = routine(client, "PPL"), routine(client, "Upper Lower")
    push = day(client, ppl, "Push")
    with pytest.raises(IntegrityError, match="turn_day_of_routine"), engine.begin() as conn:
        conn.execute(
            text("insert into turn (routine_id, day_id, position) values (:r, :d, 0)"), {"r": ul, "d": push["id"]}
        )


def test_a_day_cannot_move_to_another_routine(client: TestClient, engine: Engine) -> None:
    ppl, ul = routine(client, "PPL"), routine(client, "Upper Lower")
    push = day(client, ppl, "Push")
    with pytest.raises(IntegrityError, match="turn_day_of_routine"), engine.begin() as conn:
        conn.execute(text("update day set routine_id = :r where id = :d"), {"r": ul, "d": push["id"]})


# Refusal shapes


def test_the_schema_lists_only_the_refusals_each_route_can_give(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    codes = {
        (method, path): sorted(c for c in op["responses"] if c[0] in "45")
        for path, ops in paths.items()
        for method, op in ops.items()
        if op["tags"] == ["days"]
    }
    assert codes == {
        ("get", "/api/routines/{routine_id}"): ["404", "422"],
        ("get", "/api/days/{day_id}"): ["404", "422"],
        ("post", "/api/routines/{routine_id}/days"): ["404", "409", "422"],
        ("patch", "/api/days/{day_id}"): ["404", "409", "422"],
        ("post", "/api/days/{day_id}/lines"): ["404", "409", "422"],
        ("put", "/api/days/{day_id}/lines"): ["404", "409", "422"],
        ("delete", "/api/days/{day_id}/lines/{line_id}"): ["404", "422"],
    }
