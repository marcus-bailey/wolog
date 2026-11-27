"""Spec §4.2 and §4.3 Destroy: RTN-4 (destroy a Routine nothing points at) and DAY-1 destroy.

Sessions and Skips pin their Routine and Day for good, so neither can be destroyed under them, and
they are never cascaded."""

import datetime as dt
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

TODAY = dt.datetime.now(dt.UTC).date()


def days_ago(n: int) -> str:
    return (TODAY - dt.timedelta(days=n)).isoformat()


def ok(res: httpx2.Response, code: int = 200) -> Any:
    assert res.status_code == code, res.json()
    return res.json()


def refused(res: httpx2.Response, status: int, code: str) -> str:
    assert res.status_code == status, res.json()
    assert res.json()["code"] == code
    message: str = res.json()["message"]
    return message


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

    def engage(self) -> None:
        ok(self.client.post(f"/api/routines/{self.id}/engage"))

    def detail(self) -> dict[str, Any]:
        body: dict[str, Any] = ok(self.client.get(f"/api/routines/{self.id}"))
        return body

    def rotation(self) -> list[str]:
        body = self.detail()
        names = {d["id"]: d["name"] for d in body["days"]}
        return [names[t["day_id"]] for t in body["rotation"]]

    def destroy(self) -> httpx2.Response:
        return self.client.delete(f"/api/routines/{self.id}")

    def destroy_day(self, day: str) -> httpx2.Response:
        return self.client.delete(f"/api/days/{self.day[day]}")


def skip(client: TestClient, date: str | None = None) -> None:
    """Skip what Up next suggests now on the Engaged Routine."""
    up = ok(client.get("/api/up-next"))
    body = {
        "routine_id": up["routine"]["id"],
        "turn_id": up["suggestion"]["turn_id"],
        "date": date or TODAY.isoformat(),
        "today": TODAY.isoformat(),
    }
    ok(client.post("/api/skips", json=body), 201)


def log(client: TestClient, date: str | None = None, day_id: int | None = None) -> dict[str, Any]:
    """A Session on the Engaged Routine with one Set on an extra Line, on the suggested Day or `day_id`."""
    date = date or TODAY.isoformat()
    up = ok(client.get(f"/api/up-next?on={date}"))
    day = day_id if day_id is not None else up["suggestion"]["day_id"]
    body = {
        "date": date,
        "today": TODAY.isoformat(),
        "routine_id": up["routine"]["id"],
        "turn_id": up["suggestion"]["turn_id"],
        "day_id": day,
        "day_lines": [line["id"] for line in ok(client.get(f"/api/days/{day}"))["lines"]],
        "lines": [{"name": "Curls", "sets": [{"reps": 5, "weight": "20"}]}],
    }
    session: dict[str, Any] = ok(client.post("/api/sessions", json=body), 201)
    return session


def count(engine: Engine, table: str) -> int:
    with engine.connect() as conn:
        return int(conn.scalar(text(f"select count(*) from {table}")) or 0)


# Destroy a Day (DAY-1)


def test_destroy_day_removes_it_with_its_turns_and_lines(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench", "Dips"], Pull=["Rows"], Legs=["Squat"])
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": ppl.day["Push"]}))
    res = ok(ppl.destroy_day("Push"))
    assert res == ppl.detail()
    assert [d["name"] for d in res["days"]] == ["Pull", "Legs"]
    assert ppl.rotation() == ["Pull", "Legs"]
    assert count(engine, "day_line") == 2
    refused(client.get(f"/api/days/{ppl.day['Push']}"), 404, "not_found")


def test_destroy_day_keeps_its_exercises_in_the_library(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench", "Dips"])
    ok(ppl.destroy_day("Push"))
    assert [e["name"] for e in ok(client.get("/api/exercises"))] == ["Bench", "Dips"]


def test_the_rotation_stays_numbered_after_a_destroy(client: TestClient) -> None:
    ppl = Routine(client, A=[], B=[], C=[])
    ok(ppl.destroy_day("A"))
    ok(client.post(f"/api/routines/{ppl.id}/days", json={"name": "D"}), 201)
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": ppl.day["B"]}))
    assert ppl.rotation() == ["B", "C", "D", "B"]


def test_destroy_day_off_the_rotation(client: TestClient) -> None:
    ppl = Routine(client, Push=[], Pull=[])
    ok(client.post(f"/api/days/{ppl.day['Push']}/drop"))
    ok(ppl.destroy_day("Push"))
    assert ppl.rotation() == ["Pull"]


def test_destroy_day_pinned_by_a_session_is_refused_and_offers_drop(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=[])
    log(client, days_ago(1))
    message = refused(ppl.destroy_day("Push"), 409, "day_pinned")
    assert message == (
        "“Push” can’t be destroyed: 1 Session points at it. Drop it from the rotation instead; "
        "it stays in the Routine with its Lines."
    )
    assert ppl.rotation() == ["Push", "Pull"]
    assert [d["name"] for d in ppl.detail()["days"]] == ["Push", "Pull"]
    assert count(engine, "session") == 1


def test_destroy_day_pinned_by_skips_is_refused(client: TestClient) -> None:
    ppl = Routine(client, Push=[], Pull=[])
    skip(client, days_ago(2))
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": ppl.day["Push"]}))
    skip(client, days_ago(1))  # Pull
    skip(client, days_ago(1))  # Push again
    message = refused(ppl.destroy_day("Push"), 409, "day_pinned")
    assert message.startswith("“Push” can’t be destroyed: 2 Skips point at it.")
    refused(ppl.destroy_day("Pull"), 409, "day_pinned")


def test_destroy_day_pinned_by_sessions_and_skips_names_both(client: TestClient) -> None:
    ppl = Routine(client, Push=[])
    log(client, days_ago(3))
    log(client, days_ago(2))
    skip(client, days_ago(1))
    message = refused(ppl.destroy_day("Push"), 409, "day_pinned")
    assert message.startswith("“Push” can’t be destroyed: 2 Sessions and 1 Skip point at it.")


def test_a_day_whose_turn_is_gone_is_still_pinned(client: TestClient) -> None:
    ppl = Routine(client, Push=[], Pull=[])
    log(client, days_ago(1))
    ok(client.post(f"/api/days/{ppl.day['Push']}/drop"))  # the Session's Turn pin dangles
    message = refused(ppl.destroy_day("Push"), 409, "day_pinned")
    assert message == (
        "“Push” can’t be destroyed: 1 Session points at it. It is off the rotation already, and can stay there."
    )


def test_a_day_a_session_changed_to_is_pinned_and_the_old_one_is_free(client: TestClient) -> None:
    ppl = Routine(client, Push=[], Pull=[])
    session = log(client, days_ago(1))
    lines = [{"id": line["id"], "sets": line["sets"]} for line in session["lines"]]
    body = {"version": session["version"], "day_id": ppl.day["Pull"], "lines": lines}
    ok(client.put(f"/api/sessions/{session['id']}", json=body))
    refused(ppl.destroy_day("Pull"), 409, "day_pinned")
    ok(ppl.destroy_day("Push"))


def test_a_day_becomes_destroyable_once_its_session_is_deleted(client: TestClient) -> None:
    ppl = Routine(client, Push=[])
    session = log(client, days_ago(1))
    assert client.delete(f"/api/sessions/{session['id']}").status_code == 204
    ok(ppl.destroy_day("Push"))
    assert ppl.detail()["days"] == []


@pytest.mark.parametrize("day_id", [999, 0, 2**31])
def test_destroying_an_unknown_day_is_refused(client: TestClient, day_id: int) -> None:
    refused(client.delete(f"/api/days/{day_id}"), 404, "not_found")


# Destroy a Routine (RTN-4)


def test_destroy_a_routine_that_is_not_engaged(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=["Rows"])
    ul = Routine(client, "Upper Lower", Upper=["Rows", "Press"], Lower=["Squat"])
    res = ul.destroy()
    assert res.status_code == 204
    assert [r["name"] for r in ok(client.get("/api/routines"))] == ["PPL"]
    refused(client.get(f"/api/routines/{ul.id}"), 404, "not_found")
    refused(client.get(f"/api/days/{ul.day['Upper']}"), 404, "not_found")
    assert count(engine, "day") == 2
    assert count(engine, "day_line") == 2
    assert count(engine, "turn") == 2
    assert [e["name"] for e in ok(client.get("/api/exercises"))] == ["Bench", "Press", "Rows", "Squat"]
    assert ppl.rotation() == ["Push", "Pull"]


def test_destroy_routine_pinned_by_a_session_is_refused(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=[])
    ul = Routine(client, "Upper Lower")
    log(client, days_ago(1))
    ul.engage()
    message = refused(ppl.destroy(), 409, "routine_pinned")
    assert message == "“PPL” can’t be destroyed: 1 Session points at it or its Days."
    assert count(engine, "session") == 1
    assert len(ok(client.get("/api/routines"))) == 2


def test_destroy_routine_pinned_by_skips_is_refused(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=[], Pull=[])
    ul = Routine(client, "Upper Lower")
    skip(client, days_ago(1))
    skip(client)
    ul.engage()
    message = refused(ppl.destroy(), 409, "routine_pinned")
    assert message == "“PPL” can’t be destroyed: 2 Skips point at it or its Days."
    assert count(engine, "skip") == 2


def test_the_engaged_routine_cannot_be_destroyed_while_another_exists(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench"])
    Routine(client, "Upper Lower")
    message = refused(ppl.destroy(), 409, "routine_engaged")
    assert message == "“PPL” is the Engaged Routine. Switch to another Routine first, then destroy it."
    assert [r["name"] for r in ok(client.get("/api/routines"))] == ["PPL", "Upper Lower"]


def test_once_switched_away_the_former_engaged_routine_can_be_destroyed(client: TestClient) -> None:
    ppl = Routine(client, Push=[])
    ul = Routine(client, "Upper Lower")
    ul.engage()
    assert ppl.destroy().status_code == 204
    assert ok(client.get("/api/routines")) == [{"id": ul.id, "name": "Upper Lower", "engaged": True}]


def test_destroying_the_only_routine_returns_to_first_run(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench"], Pull=[])
    assert ppl.destroy().status_code == 204
    assert ok(client.get("/api/routines")) == []
    assert ok(client.get("/api/up-next")) == {"routine": None, "suggestion": None, "last_skip": None}
    assert count(engine, "day") == 0
    assert ok(client.post("/api/routines", json={"name": "Full Body"}), 201)["engaged"] is True


def test_the_only_routine_when_pinned_is_refused_as_pinned(client: TestClient) -> None:
    ppl = Routine(client, Push=[])
    log(client)
    refused(ppl.destroy(), 409, "routine_pinned")


@pytest.mark.parametrize("routine_id", [999, 0, 2**31])
def test_destroying_an_unknown_routine_is_refused(client: TestClient, routine_id: int) -> None:
    refused(client.delete(f"/api/routines/{routine_id}"), 404, "not_found")


def test_the_schema_lists_the_refusals_of_duplicate_and_destroy(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]

    def codes(method: str, path: str) -> list[str]:
        return sorted(c for c in paths[path][method]["responses"] if c[0] in "45")

    assert codes("delete", "/api/routines/{routine_id}") == ["404", "409", "422"]
    assert codes("delete", "/api/days/{day_id}") == ["404", "409", "422"]
    assert codes("post", "/api/routines/{routine_id}/duplicate") == ["404", "409", "422"]
    assert codes("post", "/api/days/{day_id}/duplicate") == ["404", "409", "422"]
