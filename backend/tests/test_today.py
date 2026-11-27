"""Spec §4.4 (cursor, suggestion, Skip, Undo last Skip) and §4.7; TDY-1, TDY-3, TDY-5."""

import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

TODAY = dt.datetime.now(dt.UTC).date()


def days_ago(n: int) -> str:
    return (TODAY - dt.timedelta(days=n)).isoformat()


class Routine:
    """A Routine with Days, each with one Turn, in order."""

    def __init__(self, client: TestClient, *days: str, name: str = "PPL") -> None:
        self.client = client
        res = client.post("/api/routines", json={"name": name})
        assert res.status_code == 201, res.json()
        self.id: int = res.json()["id"]
        self.day: dict[str, int] = {}
        for day in days:
            res = client.post(f"/api/routines/{self.id}/days", json={"name": day})
            assert res.status_code == 201, res.json()
            self.day[day] = res.json()["id"]

    def engage(self) -> None:
        assert self.client.post(f"/api/routines/{self.id}/engage").status_code == 200

    def turns(self) -> list[int]:
        return [t["id"] for t in self.client.get(f"/api/routines/{self.id}").json()["rotation"]]


def up_next(client: TestClient) -> dict[str, Any]:
    body: dict[str, Any] = client.get("/api/up-next").json()
    return body


def suggested(client: TestClient) -> str | None:
    s = up_next(client)["suggestion"]
    return None if s is None else f"{s['day_name']} {s['position']}/{s['of']}"


def skip(client: TestClient, date: str | None = None, **override: Any) -> httpx2.Response:
    """Skip what Up next suggests now (or what `override` says the owner saw)."""
    now = up_next(client)
    body = {
        "routine_id": now["routine"]["id"] if now["routine"] else 1,
        "turn_id": now["suggestion"]["turn_id"] if now["suggestion"] else 1,
        "date": date or TODAY.isoformat(),
        "today": TODAY.isoformat(),
        **override,
    }
    return client.post("/api/skips", json=body)


def skipped(client: TestClient, date: str | None = None) -> dict[str, Any]:
    res = skip(client, date)
    assert res.status_code == 201, res.json()
    body: dict[str, Any] = res.json()
    return body


def undo(client: TestClient, skip_id: int | None = None) -> httpx2.Response:
    if skip_id is None:
        skip_id = up_next(client)["last_skip"]["id"]
    return client.delete(f"/api/skips/{skip_id}")


# Up next (TDY-1, TDY-5)


def test_with_no_routine_there_is_nothing_up_next(client: TestClient) -> None:
    assert up_next(client) == {"routine": None, "suggestion": None, "last_skip": None}


def test_with_an_empty_rotation_there_is_no_suggestion(client: TestClient) -> None:
    r = Routine(client)
    assert up_next(client) == {
        "routine": {"id": r.id, "name": "PPL", "engaged": True},
        "suggestion": None,
        "last_skip": None,
    }
    Routine(client, "Push", name="Other")  # not engaged: its Days don't count
    assert up_next(client)["suggestion"] is None


def test_with_no_skips_the_suggestion_is_the_first_turn(client: TestClient) -> None:
    r = Routine(client, "Push", "Pull", "Legs")
    first = r.turns()[0]
    assert up_next(client)["suggestion"] == {
        "turn_id": first,
        "day_id": r.day["Push"],
        "day_name": "Push",
        "position": 1,
        "of": 3,
    }


def test_the_suggestion_is_derived_not_stored(client: TestClient) -> None:
    r = Routine(client, "Push", "Pull", "Legs")
    turns = r.turns()
    client.put(f"/api/routines/{r.id}/turns", json={"turn_ids": [turns[2], turns[0], turns[1]]})
    assert suggested(client) == "Legs 1/3"  # follows the current order at once


# The cursor


def test_each_skip_advances_to_the_next_turn_and_it_wraps(client: TestClient) -> None:
    Routine(client, "Push", "Pull", "Legs")
    assert suggested(client) == "Push 1/3"
    skipped(client)
    assert suggested(client) == "Pull 2/3"
    skipped(client)
    assert suggested(client) == "Legs 3/3"
    skipped(client)
    assert suggested(client) == "Push 1/3"


def test_the_next_turn_follows_the_current_order(client: TestClient) -> None:
    r = Routine(client, "A", "B", "C")
    a, b, c = r.turns()
    skipped(client)  # cursor on A's Turn
    client.put(f"/api/routines/{r.id}/turns", json={"turn_ids": [b, c, a]})
    assert suggested(client) == "B 1/3"  # after A, wrapping


def test_repeated_days_are_separate_turns(client: TestClient) -> None:
    r = Routine(client, "A", "B")
    client.post(f"/api/routines/{r.id}/turns", json={"day_id": r.day["A"]})  # A, B, A
    seen = []
    for _ in range(4):
        seen.append(suggested(client))
        skipped(client)
    assert seen == ["A 1/3", "B 2/3", "A 3/3", "A 1/3"]


def test_skips_apply_in_date_order_then_order_within_the_date(client: TestClient, engine: Engine) -> None:
    r = Routine(client, "A", "B", "C")
    a, b, c = r.turns()
    with engine.begin() as conn:  # made out of date order: the later date wins, whatever the order made
        for turn, day, date in [(c, "C", days_ago(1)), (b, "B", days_ago(3)), (a, "A", days_ago(2))]:
            conn.execute(
                text("insert into skip (date, routine_id, day_id, turn_id) values (:d, :r, :day, :t)"),
                {"d": date, "r": r.id, "day": r.day[day], "t": turn},
            )
    assert suggested(client) == "A 1/3"  # after C (the latest date), wrapping
    skipped(client, days_ago(1))
    skipped(client, days_ago(1))
    assert suggested(client) == "C 3/3"  # within a date, the later Skip wins


def test_the_cursor_walks_back_past_skips_whose_turn_was_removed(client: TestClient) -> None:
    r = Routine(client, "A", "B", "C", "D")
    a, b, c, d = r.turns()
    skipped(client)  # A
    skipped(client)  # B
    assert suggested(client) == "C 3/4"
    client.delete(f"/api/routines/{r.id}/turns/{b}")
    assert suggested(client) == "C 2/3"  # back to A's Skip; next after A in the current order
    client.delete(f"/api/routines/{r.id}/turns/{a}")
    assert suggested(client) == "C 1/2"  # no Skip holds a surviving Turn: the first Turn


def test_a_skip_whose_turn_is_gone_holds_no_turn(client: TestClient, engine: Engine) -> None:
    r = Routine(client, "A", "B")
    skipped(client)
    client.post(f"/api/days/{r.day['A']}/drop")
    client.post(f"/api/days/{r.day['A']}/put-back")  # a new Turn for A, not the one the Skip pinned
    with engine.connect() as conn:
        assert conn.execute(text("select day_id, turn_id from skip")).one() == (r.day["A"], None)
    assert suggested(client) == "B 1/2"


def test_removing_the_cursor_turn_with_no_earlier_skip_suggests_the_first(client: TestClient) -> None:
    r = Routine(client, "A", "B", "C")
    skipped(client)
    skipped(client)  # cursor on B; A's Skip earlier
    a, b, _ = r.turns()
    client.delete(f"/api/routines/{r.id}/turns/{a}")
    client.delete(f"/api/routines/{r.id}/turns/{b}")
    assert suggested(client) == "C 1/1"


# Skip (TDY-3)


def test_a_skip_records_date_routine_turn_and_day(client: TestClient, engine: Engine) -> None:
    r = Routine(client, "Push", "Pull")
    turn = r.turns()[0]
    res = skip(client, days_ago(2))
    assert res.status_code == 201
    assert res.json()["last_skip"] == {
        "id": res.json()["last_skip"]["id"],
        "date": days_ago(2),
        "day_id": r.day["Push"],
        "day_name": "Push",
    }
    assert res.json()["suggestion"]["day_name"] == "Pull"
    with engine.connect() as conn:
        row = conn.execute(text("select date, routine_id, day_id, turn_id from skip")).one()
    assert (row.date.isoformat(), row.routine_id, row.day_id, row.turn_id) == (days_ago(2), r.id, r.day["Push"], turn)


def test_several_skips_may_share_a_date(client: TestClient) -> None:
    Routine(client, "A", "B", "C")
    for _ in range(3):
        skipped(client)
    assert suggested(client) == "A 1/3"


def test_skip_is_allowed_before_any_session_and_on_a_past_date(client: TestClient) -> None:
    Routine(client, "A", "B")
    assert skip(client, days_ago(30)).status_code == 201


def test_the_skip_date_defaults_to_today_in_the_client(client: TestClient) -> None:
    """The API has no default: the SPA fills today. A missing date is refused."""
    r = Routine(client, "A")
    res = client.post("/api/skips", json={"routine_id": r.id, "turn_id": r.turns()[0], "today": TODAY.isoformat()})
    assert res.status_code == 422
    assert res.json()["code"] == "invalid_request"


def test_a_skip_in_the_future_is_refused(client: TestClient) -> None:
    Routine(client, "A", "B")
    res = skip(client, (TODAY + dt.timedelta(days=1)).isoformat())
    assert res.status_code == 422
    assert res.json() == {"code": "date_in_future", "message": "A Skip can’t be dated in the future."}
    assert up_next(client)["last_skip"] is None


def test_a_skip_before_the_last_skip_date_is_refused(client: TestClient) -> None:
    Routine(client, "A", "B")
    last = dt.date.fromisoformat(days_ago(3))
    skipped(client, days_ago(3))
    res = skip(client, days_ago(4))
    assert res.status_code == 409
    assert res.json() == {
        "code": "date_before_last_skip",
        "message": f"A Skip must be dated on or after {last.day} {last:%b %Y}, the date of this Routine’s last Skip.",
    }
    assert skip(client, days_ago(3)).status_code == 201  # on the same date is fine


def test_the_last_skip_date_is_per_routine(client: TestClient) -> None:
    Routine(client, "A", name="PPL")
    skipped(client, days_ago(1))
    other = Routine(client, "X", name="Other")
    other.engage()
    assert skip(client, days_ago(5)).status_code == 201


def test_skip_is_refused_with_an_empty_rotation(client: TestClient) -> None:
    r = Routine(client)
    res = skip(client, routine_id=r.id, turn_id=1)
    assert res.status_code == 409
    assert res.json() == {
        "code": "rotation_empty",
        "message": "Nothing is on the rotation of “PPL”, so there is nothing to Skip.",
    }


def test_skip_is_refused_with_no_routine(client: TestClient) -> None:
    res = skip(client, routine_id=1, turn_id=1)
    assert res.status_code == 409
    assert res.json() == {"code": "no_routine", "message": "There is no Routine yet. Create one first."}


def test_skip_is_refused_if_the_suggestion_changed(client: TestClient) -> None:
    r = Routine(client, "A", "B")
    seen = up_next(client)["suggestion"]["turn_id"]
    skipped(client)  # e.g. a second tab, or a double tap
    res = skip(client, turn_id=seen, routine_id=r.id)
    assert res.status_code == 409
    assert res.json() == {"code": "suggestion_changed", "message": "Up next is now B. Check it and try again."}
    assert suggested(client) == "B 2/2"


def test_skip_is_refused_if_the_engaged_routine_switched(client: TestClient) -> None:
    ppl = Routine(client, "A", name="PPL")
    seen = up_next(client)["suggestion"]["turn_id"]
    Routine(client, "X", name="Other").engage()
    res = skip(client, routine_id=ppl.id, turn_id=seen)
    assert res.status_code == 409
    assert res.json() == {
        "code": "routine_switched",
        "message": "The Engaged Routine is now “Other”. Up next has changed; check it and try again.",
    }


@pytest.mark.parametrize("offset", [-3, 3, 400])
def test_an_implausible_today_is_refused(client: TestClient, offset: int) -> None:
    Routine(client, "A")
    today = TODAY + dt.timedelta(days=offset)
    res = skip(client, today=today.isoformat(), date=today.isoformat())
    assert res.status_code == 422
    assert res.json()["code"] == "today_implausible"


@pytest.mark.parametrize("offset", [-1, 1])
def test_a_today_a_time_zone_away_is_accepted(client: TestClient, offset: int) -> None:
    Routine(client, "A")
    today = (TODAY + dt.timedelta(days=offset)).isoformat()
    assert skip(client, today=today, date=today).status_code == 201


def test_concurrent_skips_of_one_suggestion_make_one_skip(client: TestClient) -> None:
    Routine(client, "A", "B", "C")
    now = up_next(client)
    body = {
        "routine_id": now["routine"]["id"],
        "turn_id": now["suggestion"]["turn_id"],
        "date": TODAY.isoformat(),
        "today": TODAY.isoformat(),
    }
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: client.post("/api/skips", json=body), range(6)))
    assert sorted(r.status_code for r in results) == [201] + [409] * 5
    assert suggested(client) == "B 2/3"


# Undo last Skip


def test_undo_removes_the_last_skip_only(client: TestClient) -> None:
    Routine(client, "A", "B", "C")
    skipped(client, days_ago(2))
    skipped(client, days_ago(1))
    assert suggested(client) == "C 3/3"
    res = undo(client)
    assert res.status_code == 200
    assert res.json()["suggestion"]["day_name"] == "B"
    assert res.json()["last_skip"]["date"] == days_ago(2)
    undo(client)
    assert up_next(client)["last_skip"] is None
    assert suggested(client) == "A 1/3"


def test_undo_last_skip_is_by_date_then_order(client: TestClient, engine: Engine) -> None:
    r = Routine(client, "A", "B")
    a, b = r.turns()
    with engine.begin() as conn:
        conn.execute(
            text("insert into skip (date, routine_id, day_id, turn_id) values (:d1, :r, :b, :tb), (:d2, :r, :a, :ta)"),
            {"d1": days_ago(1), "d2": days_ago(2), "r": r.id, "a": r.day["A"], "b": r.day["B"], "ta": a, "tb": b},
        )
    assert up_next(client)["last_skip"]["day_name"] == "B"  # the later date, though made first


def test_only_the_last_skip_can_be_undone(client: TestClient) -> None:
    Routine(client, "A", "B")
    first = skipped(client)["last_skip"]["id"]
    skipped(client)
    res = undo(client, first)
    assert res.status_code == 409
    assert res.json()["code"] == "not_last_skip"
    assert res.json()["message"] == "Only the last Skip of the Engaged Routine can be undone."
    assert suggested(client) == "A 1/2"


def test_undo_acts_only_on_the_engaged_routine(client: TestClient) -> None:
    Routine(client, "A", "B", name="PPL")
    ppl_skip = skipped(client)["last_skip"]["id"]
    Routine(client, "X", name="Other").engage()
    assert undo(client, ppl_skip).json()["code"] == "not_last_skip"


def test_undoing_twice_is_refused_the_second_time(client: TestClient) -> None:
    Routine(client, "A", "B")
    skipped(client)
    last = skipped(client)["last_skip"]["id"]
    assert undo(client, last).status_code == 200
    res = undo(client, last)
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Skip no longer exists."}


def test_an_undone_skip_whose_turn_is_gone_still_undoes(client: TestClient) -> None:
    r = Routine(client, "A", "B")
    skipped(client)
    client.post(f"/api/days/{r.day['A']}/drop")
    assert undo(client).status_code == 200
    assert up_next(client)["last_skip"] is None


# Switching (§4.7)


def test_switching_recomputes_and_returning_resumes(client: TestClient) -> None:
    ppl = Routine(client, "Push", "Pull", "Legs", name="PPL")
    skipped(client)
    assert suggested(client) == "Pull 2/3"
    ul = Routine(client, "Upper", "Lower", name="Upper Lower")
    ul.engage()
    assert suggested(client) == "Upper 1/2"
    assert up_next(client)["last_skip"] is None  # its own data only
    skipped(client)
    ppl.engage()
    assert suggested(client) == "Pull 2/3"  # where it left off
    ul.engage()
    assert suggested(client) == "Lower 2/2"


# The next Turn in Routine detail (§5)


def test_routine_detail_marks_the_next_turn_engaged_or_not(client: TestClient) -> None:
    ppl = Routine(client, "Push", "Pull", "Legs", name="PPL")
    push, pull, _ = ppl.turns()

    def detail(r: Routine) -> dict[str, Any]:
        body: dict[str, Any] = client.get(f"/api/routines/{r.id}").json()
        return body

    assert detail(ppl)["next_turn_id"] == push
    skipped(client)
    assert detail(ppl)["next_turn_id"] == pull == up_next(client)["suggestion"]["turn_id"]
    Routine(client, "Upper", name="Upper Lower").engage()
    assert detail(ppl)["next_turn_id"] == pull  # frozen, not engaged


# The database, below the API


def test_a_skip_pins_its_day_and_routine(client: TestClient, engine: Engine) -> None:
    r = Routine(client, "A")
    skipped(client)
    with pytest.raises(IntegrityError, match="skip_day_of_routine"), engine.begin() as conn:
        conn.execute(text("delete from day where id = :d"), {"d": r.day["A"]})
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("delete from routine where id = :r"), {"r": r.id})


def test_a_skips_day_belongs_to_its_routine(client: TestClient, engine: Engine) -> None:
    Routine(client, "A", name="PPL")
    other = Routine(client, "X", name="Other")
    with pytest.raises(IntegrityError, match="skip_day_of_routine"), engine.begin() as conn:
        conn.execute(
            text("insert into skip (date, routine_id, day_id) values (current_date, 1, :d)"), {"d": other.day["X"]}
        )


def test_a_skips_turn_names_its_day(client: TestClient, engine: Engine) -> None:
    r = Routine(client, "A", "B")
    a, _ = r.turns()
    with pytest.raises(IntegrityError, match="skip_turn_of_day"), engine.begin() as conn:
        conn.execute(
            text("insert into skip (date, routine_id, day_id, turn_id) values (current_date, :r, :d, :t)"),
            {"r": r.id, "d": r.day["B"], "t": a},
        )


# Refusal shapes


def test_the_schema_lists_only_the_refusals_each_route_can_give(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    codes = {
        (method, path): sorted(c for c in op["responses"] if c[0] in "45")
        for path, ops in paths.items()
        for method, op in ops.items()
        if op["tags"] == ["today"]
    }
    assert codes == {
        ("get", "/api/up-next"): [],
        ("post", "/api/skips"): ["409", "422"],
        ("delete", "/api/skips/{skip_id}"): ["404", "409", "422"],
    }
