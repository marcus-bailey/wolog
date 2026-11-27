"""Spec §3 (Writes are post-state), §4.4 (Skips and new Sessions, Cursor), §4.5 (Creation, The first
Set pins, One Session per date, Snapshot), §4.6 and §4.7: LOG-1, LOG-2, LOG-8."""

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

    def engage(self) -> None:
        ok(self.client.post(f"/api/routines/{self.id}/engage"))

    def turns(self) -> list[int]:
        return [t["id"] for t in ok(self.client.get(f"/api/routines/{self.id}"))["rotation"]]


def up_next(client: TestClient) -> dict[str, Any]:
    body: dict[str, Any] = ok(client.get("/api/up-next"))
    return body


def suggested(client: TestClient) -> str | None:
    s = up_next(client)["suggestion"]
    return None if s is None else str(s["day_name"])


def day_lines(client: TestClient, day_id: int) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = ok(client.get(f"/api/days/{day_id}"))["lines"]
    return lines


def a_set(reps: int = 5, weight: str = "135", **more: Any) -> dict[str, Any]:
    return {"reps": reps, "weight": weight, **more}


def start(
    client: TestClient,
    date: str | None = None,
    sets: dict[int, list[dict[str, Any]]] | None = None,
    lines: list[dict[str, Any]] | None = None,
    **override: Any,
) -> httpx2.Response:
    """Save the first Set(s) on what Up next suggests now, as the logger would: every Line of the
    suggested Day in order, with `sets` by Line index (default: one Set on the first Line)."""
    now = up_next(client)
    seen: list[int] = []
    if now["suggestion"] is not None:
        seen = [line["id"] for line in day_lines(client, now["suggestion"]["day_id"])]
    if lines is None:
        given = {0: [a_set()]} if sets is None else sets
        lines = [{"day_line_id": dl, "sets": given.get(i, [])} for i, dl in enumerate(seen)]
    body = {
        "date": date or TODAY.isoformat(),
        "today": TODAY.isoformat(),
        "routine_id": now["routine"]["id"] if now["routine"] else 1,
        "turn_id": now["suggestion"]["turn_id"] if now["suggestion"] else 1,
        "day_lines": seen,
        "lines": lines,
        **override,
    }
    return client.post("/api/sessions", json=body)


def started(client: TestClient, date: str | None = None, **kw: Any) -> dict[str, Any]:
    body: dict[str, Any] = ok(start(client, date, **kw), 201)
    return body


def on(client: TestClient, date: str | None = None) -> dict[str, Any] | None:
    body: dict[str, Any] | None = ok(client.get(f"/api/sessions/on/{date or TODAY.isoformat()}"))
    return body


def write(client: TestClient, session: dict[str, Any], lines: list[dict[str, Any]]) -> httpx2.Response:
    return client.put(f"/api/sessions/{session['id']}", json={"lines": lines})


def post_state(session: dict[str, Any]) -> list[dict[str, Any]]:
    """The Session's Lines and Sets as the screen would send them back unchanged."""
    return [{"id": line["id"], "sets": [dict(s) for s in line["sets"]]} for line in session["lines"]]


def shape(session: dict[str, Any]) -> list[tuple[str, list[str]]]:
    """Each Line's Exercise and its Sets as "weight×reps" (w for Warmup)."""
    return [
        (
            line["exercise"]["name"],
            [f"{s['weight']}×{s['reps']}{'w' if s['warmup'] else ''}" for s in line["sets"]],
        )
        for line in session["lines"]
    ]


def refused(res: httpx2.Response, status: int, code: str) -> str:
    assert res.status_code == status, res.json()
    assert res.json()["code"] == code, res.json()
    message: str = res.json()["message"]
    return message


def count(engine: Engine, table: str) -> int:
    with engine.connect() as conn:
        n: int = conn.scalar(text(f"select count(*) from {table}")) or 0
    return n


# Start: nothing is saved until the first Set (LOG-1)


def test_opening_the_logger_and_choosing_a_day_saves_nothing(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench Press", "Dips"])
    day_lines(client, up_next(client)["suggestion"]["day_id"])
    assert on(client) is None
    assert count(engine, "session") == 0
    assert ppl.id


def test_a_write_with_no_set_is_not_a_start(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    message = refused(start(client, sets={}), 422, "no_set")
    assert "first Set" in message
    assert on(client) is None
    assert count(engine, "session") == 0
    assert count(engine, "session_line") == 0


# The first Set creates the Session with the Snapshot


def test_the_first_set_creates_the_session_from_the_snapshot_of_the_day(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press", "Dips", "Flyes"], Pull=["Rows"])
    session = started(client, sets={1: [a_set(8, "0")]})
    assert session["date"] == TODAY.isoformat()
    assert session["routine"] == {"id": ppl.id, "name": "PPL"}
    assert session["day"] == {"id": ppl.day["Push"], "name": "Push"}
    assert session["turn_id"] == ppl.turns()[0]
    assert shape(session) == [("Bench Press", []), ("Dips", ["0×8"]), ("Flyes", [])]
    assert on(client) == session


def test_the_screens_omissions_reorders_and_extra_lines_apply_after_the_snapshot(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips", "Flyes"])
    curls = ok(client.post("/api/exercises", json={"name": "Curls"}), 201)["id"]
    bench, dips, _flyes = [line["id"] for line in day_lines(client, up_next(client)["suggestion"]["day_id"])]
    session = started(
        client,
        lines=[
            {"day_line_id": dips, "sets": []},
            {"exercise_id": curls, "sets": [a_set(12, "25")]},
            {"day_line_id": bench, "sets": [a_set(5, "45", warmup=True), a_set(5, "135")]},
            {"exercise_id": curls, "sets": []},
        ],
    )
    assert shape(session) == [
        ("Dips", []),
        ("Curls", ["25×12"]),
        ("Bench Press", ["45×5w", "135×5"]),
        ("Curls", []),
    ]


def test_an_empty_day_is_still_valid(client: TestClient) -> None:
    ppl = Routine(client, Rest=[])
    curls = ok(client.post("/api/exercises", json={"name": "Curls"}), 201)["id"]
    session = started(client, lines=[{"exercise_id": curls, "sets": [a_set()]}])
    assert session["day"]["id"] == ppl.day["Rest"]
    assert shape(session) == [("Curls", ["135×5"])]


def test_a_line_can_name_a_day_line_or_an_exercise_not_both(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    bench = day_lines(client, up_next(client)["suggestion"]["day_id"])[0]
    both = [{"day_line_id": bench["id"], "exercise_id": bench["exercise"]["id"], "sets": [a_set()]}]
    refused(start(client, lines=both), 422, "invalid_request")
    refused(start(client, lines=[{"sets": [a_set()]}]), 422, "invalid_request")


def test_a_day_line_used_twice_is_refused(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    bench = day_lines(client, up_next(client)["suggestion"]["day_id"])[0]["id"]
    twice = [{"day_line_id": bench, "sets": [a_set()]}, {"day_line_id": bench, "sets": []}]
    refused(start(client, lines=twice), 409, "day_changed")


def test_a_day_edited_since_the_logger_opened_is_refused(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench Press"])
    seen = [line["id"] for line in day_lines(client, ppl.day["Push"])]
    ok(client.post(f"/api/days/{ppl.day['Push']}/lines", json={"name": "Dips"}), 201)
    res = start(client, day_lines=seen, lines=[{"day_line_id": seen[0], "sets": [a_set()]}])
    assert "Lines of Push changed" in refused(res, 409, "day_changed")
    assert count(engine, "session") == 0


def test_a_line_of_another_day_is_refused(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press"], Pull=["Rows"])
    rows = day_lines(client, ppl.day["Pull"])[0]["id"]
    refused(start(client, lines=[{"day_line_id": rows, "sets": [a_set()]}]), 409, "day_changed")


def test_an_extra_line_cannot_pick_a_retired_exercise(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    old = ok(client.post("/api/exercises", json={"name": "Old"}), 201)["id"]
    ok(client.patch(f"/api/exercises/{old}", json={"retired": True}))
    res = start(client, lines=[{"exercise_id": old, "sets": [a_set()]}])
    assert "Retired" in refused(res, 409, "exercise_retired")
    refused(start(client, lines=[{"exercise_id": 999, "sets": [a_set()]}]), 404, "not_found")


def test_a_day_line_of_a_retired_exercise_still_takes_sets(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    bench = day_lines(client, up_next(client)["suggestion"]["day_id"])[0]
    ok(client.patch(f"/api/exercises/{bench['exercise']['id']}", json={"retired": True}))
    assert shape(started(client)) == [("Bench Press", ["135×5"])]


# The date


def test_the_date_is_the_civil_date_given_with_no_timestamp(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    session = started(client, days_ago(3))
    assert session["date"] == days_ago(3)
    with engine.connect() as conn:
        kinds: dict[str, str] = dict(
            conn.execute(
                text("select column_name, data_type from information_schema.columns where table_name = 'session'")
            ).all()
        )
    assert kinds["date"] == "date"
    assert not any("time" in kind for kind in kinds.values())


def test_a_future_date_is_refused(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    tomorrow = (TODAY + dt.timedelta(days=1)).isoformat()
    refused(start(client, tomorrow), 422, "date_in_future")
    assert count(engine, "session") == 0


@pytest.mark.parametrize("offset", [-2, 2])
def test_an_implausible_today_is_refused(client: TestClient, offset: int) -> None:
    Routine(client, Push=["Bench Press"])
    today = (TODAY + dt.timedelta(days=offset)).isoformat()
    refused(start(client, today, today=today), 422, "today_implausible")


# The Routine, Turn and Day pinned (LOG-8)


def test_accepting_the_suggestion_pins_the_suggested_turn(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press"], Pull=["Rows"], Legs=["Squat"])
    ok(client.post(f"/api/routines/{ppl.id}/turns", json={"day_id": ppl.day["Push"]}))  # Push Pull Legs Push
    for _ in range(3):
        ok(client.post("/api/skips", json={**_skip_body(client), "date": days_ago(5)}), 201)
    assert up_next(client)["suggestion"]["position"] == 4
    session = started(client)
    assert session["turn_id"] == ppl.turns()[3]
    assert session["day"]["name"] == "Push"


def test_a_stale_suggestion_is_refused(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press"], Pull=["Rows"])
    res = start(client, turn_id=ppl.turns()[1])
    assert "Up next is now Push" in refused(res, 409, "suggestion_changed")


def test_no_session_starts_with_an_empty_rotation(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press"])
    bench = day_lines(client, ppl.day["Push"])[0]["exercise"]["id"]
    ok(client.post(f"/api/days/{ppl.day['Push']}/drop"))
    refused(start(client, lines=[{"exercise_id": bench, "sets": [a_set()]}]), 409, "rotation_empty")


def test_no_session_starts_with_no_routine(client: TestClient) -> None:
    refused(start(client, lines=[{"exercise_id": 1, "sets": [a_set()]}]), 409, "no_routine")


def test_the_first_save_is_refused_if_the_engaged_routine_switched(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    seen = up_next(client)
    ul = Routine(client, "Upper Lower", Upper=["Rows"])
    ul.engage()
    res = start(client, routine_id=seen["routine"]["id"], turn_id=seen["suggestion"]["turn_id"])
    assert "Upper Lower" in refused(res, 409, "routine_switched")
    assert count(engine, "session") == 0
    # The logger reloads on the new suggestion, and that save works.
    assert started(client)["routine"]["name"] == "Upper Lower"


# One Session per date


def test_at_most_one_session_per_date_across_routines(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    first = started(client)
    ul = Routine(client, "Upper Lower", Upper=["Rows"])
    ul.engage()
    assert "already a Session" in refused(start(client), 409, "session_exists")
    assert on(client) == first
    assert started(client, days_ago(1))["routine"]["name"] == "Upper Lower"


def test_the_database_allows_one_session_per_date(client: TestClient, engine: Engine) -> None:
    ppl = Routine(client, Push=["Bench Press"], Pull=["Rows"])
    started(client)
    with pytest.raises(IntegrityError, match="session_one_per_date"), engine.begin() as conn:
        conn.execute(
            text("insert into session (date, routine_id, day_id) values (:d, :r, :day)"),
            {"d": TODAY, "r": ppl.id, "day": ppl.day["Pull"]},
        )


def test_the_database_keeps_a_sessions_day_in_its_routine(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    ul = Routine(client, "Upper Lower", Upper=["Rows"])
    with pytest.raises(IntegrityError, match="session_day_of_routine"), engine.begin() as conn:
        conn.execute(
            text("insert into session (date, routine_id, day_id) values (:d, 1, :day)"),
            {"d": TODAY, "day": ul.day["Upper"]},
        )


def test_concurrent_first_sets_on_one_date_make_one_session(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: start(client).status_code, range(4)))
    assert sorted(results) == [201, 409, 409, 409]
    assert count(engine, "session") == 1


def test_opening_a_date_with_no_session_answers_null(client: TestClient) -> None:
    assert on(client) is None
    refused(client.get("/api/sessions/on/not-a-date"), 422, "invalid_request")


# Skips and new Sessions


def _skip_body(client: TestClient) -> dict[str, Any]:
    now = up_next(client)
    return {
        "routine_id": now["routine"]["id"],
        "turn_id": now["suggestion"]["turn_id"],
        "date": TODAY.isoformat(),
        "today": TODAY.isoformat(),
    }


def test_a_session_replaces_this_routines_skips_on_its_date_and_pins_the_suggestion_before(
    client: TestClient, engine: Engine
) -> None:
    ppl = Routine(client, Push=["Bench Press"], Pull=["Rows"], Legs=["Squat"])
    ok(client.post("/api/skips", json={**_skip_body(client), "date": days_ago(1)}), 201)  # Push
    ok(client.post("/api/skips", json=_skip_body(client)), 201)  # Pull, today
    assert suggested(client) == "Legs"
    session = started(client)
    assert session["day"]["name"] == "Legs"
    with engine.connect() as conn:
        left = conn.execute(text("select date from skip where routine_id = :r"), {"r": ppl.id}).scalars().all()
    assert [d.isoformat() for d in left] == [days_ago(1)]
    assert suggested(client) == "Push"  # after Legs, wrapping


def test_a_session_keeps_another_routines_skips_on_its_date(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    ul = Routine(client, "Upper Lower", Upper=["Rows"])
    ok(client.post("/api/skips", json=_skip_body(client)), 201)  # PPL's Skip today
    ul.engage()
    started(client)
    assert count(engine, "skip") == 1


def test_a_skip_is_refused_on_a_date_holding_a_session_of_the_routine(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"], Pull=["Rows"])
    started(client, days_ago(1))
    res = client.post("/api/skips", json={**_skip_body(client), "date": days_ago(1)})
    assert "holds a Session" in refused(res, 409, "date_has_session")


def test_a_skip_is_refused_before_the_latest_session(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"], Pull=["Rows"])
    started(client, days_ago(1))
    res = client.post("/api/skips", json={**_skip_body(client), "date": days_ago(2)})
    refused(res, 409, "date_before_last_session")
    ok(client.post("/api/skips", json=_skip_body(client)), 201)


def test_another_routines_session_does_not_block_a_skip(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    started(client)
    ul = Routine(client, "Upper Lower", Upper=["Rows"])
    ul.engage()
    ok(client.post("/api/skips", json=_skip_body(client)), 201)


# The cursor covers Sessions


def test_the_cursor_starts_from_the_latest_session_then_later_skips(client: TestClient) -> None:
    Routine(client, A=["Bench Press"], B=["Rows"], C=["Squat"], D=["Curls"])
    assert suggested(client) == "A"
    started(client, days_ago(2))  # A
    assert suggested(client) == "B"
    ok(client.post("/api/skips", json={**_skip_body(client), "date": days_ago(1)}), 201)  # B
    assert suggested(client) == "C"
    started(client)  # C
    assert suggested(client) == "D"


def test_the_cursor_walks_back_past_a_session_whose_turn_was_removed(client: TestClient) -> None:
    ppl = Routine(client, A=["Bench Press"], B=["Rows"], C=["Squat"])
    ok(client.post("/api/skips", json={**_skip_body(client), "date": days_ago(2)}), 201)  # A
    started(client, days_ago(1))  # B
    assert suggested(client) == "C"
    b_turn = ppl.turns()[1]
    ok(client.delete(f"/api/routines/{ppl.id}/turns/{b_turn}"))
    assert suggested(client) == "C"  # back to the Skip of A; next after A is now C
    session = on(client, days_ago(1))
    assert session is not None and session["turn_id"] is None
    assert session["day"]["name"] == "B"


def test_the_cursor_walks_back_from_a_skip_to_an_earlier_session(client: TestClient) -> None:
    ppl = Routine(client, A=["Bench Press"], B=["Rows"], C=["Squat"])
    started(client, days_ago(2))  # A
    ok(client.post("/api/skips", json={**_skip_body(client), "date": days_ago(1)}), 201)  # B
    ok(client.delete(f"/api/routines/{ppl.id}/turns/{ppl.turns()[1]}"))
    assert suggested(client) == "C"  # after the Session's A


def test_the_routine_detail_marks_the_next_turn_from_sessions_too(client: TestClient) -> None:
    ppl = Routine(client, A=["Bench Press"], B=["Rows"])
    started(client)
    assert ok(client.get(f"/api/routines/{ppl.id}"))["next_turn_id"] == ppl.turns()[1]


# Sets (LOG-2, §4.6)


def test_a_set_records_reps_weight_warmup_and_note(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    session = started(client, sets={0: [a_set(5, "45", warmup=True, note="  easy  "), a_set(3, "137.5")]})
    assert session["lines"][0]["sets"] == [
        {"id": session["lines"][0]["sets"][0]["id"], "reps": 5, "weight": "45", "warmup": True, "note": "easy"},
        {"id": session["lines"][0]["sets"][1]["id"], "reps": 3, "weight": "137.5", "warmup": False, "note": None},
    ]


@pytest.mark.parametrize("typed", ["0", "22.50", "007", "135", "0.125"])
def test_weight_is_stored_as_typed(client: TestClient, typed: str) -> None:
    Routine(client, Push=["Bench Press"])
    weight = started(client, sets={0: [a_set(weight=typed)]})["lines"][0]["sets"][0]["weight"]
    assert weight == {"007": "7"}.get(typed, typed)


@pytest.mark.parametrize("weight", ["-5", "abc", "", "1e3", ".5", "5.", "1,5", "12.3456", "1234567"])
def test_an_invalid_weight_is_refused(client: TestClient, weight: str) -> None:
    Routine(client, Push=["Bench Press"])
    assert "Weight" in refused(start(client, sets={0: [a_set(weight=weight)]}), 422, "weight_invalid")


@pytest.mark.parametrize("reps", [0, -1, 2**31])
def test_reps_must_be_a_positive_integer(client: TestClient, reps: int) -> None:
    Routine(client, Push=["Bench Press"])
    assert "Reps" in refused(start(client, sets={0: [a_set(reps)]}), 422, "reps_invalid")


@pytest.mark.parametrize("reps", [2.5, "five", None])
def test_reps_that_are_not_a_whole_number_are_refused(client: TestClient, reps: Any) -> None:
    Routine(client, Push=["Bench Press"])
    refused(start(client, sets={0: [{"reps": reps, "weight": "100"}]}), 422, "invalid_request")


def test_a_blank_note_is_no_note_and_a_long_one_is_refused(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    refused(start(client, sets={0: [a_set(note="x" * 1001)]}), 422, "note_too_long")
    assert started(client, sets={0: [a_set(note="   ")]})["lines"][0]["sets"][0]["note"] is None


def test_one_invalid_set_refuses_the_whole_first_save(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    refused(start(client, sets={0: [a_set()], 1: [a_set(0)]}), 422, "reps_invalid")
    assert count(engine, "session") == 0
    assert count(engine, "session_set") == 0


def test_the_database_refuses_bad_sets(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press"])
    line = started(client)["lines"][0]["id"]
    for column, value, constraint in [
        ("reps", "0", "session_set_reps_positive"),
        ("weight", "-1", "session_set_weight_not_negative"),
    ]:
        values = {"reps": "5", "weight": "100", column: value}
        with pytest.raises(IntegrityError, match=constraint), engine.begin() as conn:
            conn.execute(
                text(f"insert into session_set (line_id, position, reps, weight) values ({line}, 9, :r, :w)"),
                {"r": int(values["reps"]), "w": values["weight"]},
            )


# Writes are post-state


def test_saving_the_next_set_appends_it(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    lines = post_state(session)
    lines[0]["sets"].append(a_set(5, "140"))
    lines[1]["sets"].append(a_set(10, "0"))
    after = ok(write(client, session, lines))
    assert shape(after) == [("Bench Press", ["135×5", "140×5"]), ("Dips", ["0×10"])]
    assert after["lines"][0]["sets"][0]["id"] == session["lines"][0]["sets"][0]["id"]
    assert on(client) == after


def test_an_unchanged_post_state_changes_nothing(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    assert ok(write(client, session, post_state(session))) == session


def test_one_invalid_set_refuses_the_whole_write(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    lines = post_state(session)
    lines[0]["sets"].append(a_set(5, "140"))
    lines[1]["sets"].append(a_set(5, "-1"))
    refused(write(client, session, lines), 422, "weight_invalid")
    assert on(client) == session


def test_a_set_cannot_move_to_another_line(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    lines = post_state(session)
    lines[1]["sets"] = lines[0]["sets"]
    lines[0]["sets"] = [a_set()]
    refused(write(client, session, lines), 409, "set_moved")
    assert on(client) == session


def test_unknown_or_repeated_ids_are_refused(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    for lines in [
        [{"id": 999, "sets": [a_set()]}],
        [*post_state(session), post_state(session)[0]],
        [{**post_state(session)[0], "sets": [{**a_set(), "id": 999}]}, post_state(session)[1]],
    ]:
        refused(write(client, session, lines), 409, "session_changed")
    assert on(client) == session


def test_a_line_with_sets_cannot_be_left_out(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client, sets={0: [a_set()], 1: [a_set()]})
    refused(write(client, session, post_state(session)[:1]), 409, "line_has_sets")
    assert on(client) == session


def test_a_line_keeps_its_exercise(client: TestClient) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    lines = post_state(session)
    lines[0]["exercise_id"] = session["lines"][1]["exercise"]["id"]
    refused(write(client, session, lines), 422, "invalid_request")


def test_a_write_leaving_no_set_erases_the_session(client: TestClient, engine: Engine) -> None:
    Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    lines = post_state(session)
    lines[0]["sets"] = []
    assert ok(write(client, session, lines)) is None
    assert on(client) is None
    assert count(engine, "session_line") == 0
    refused(write(client, session, lines), 404, "not_found")
    assert started(client)["id"] != session["id"]


# The Session and the Day stay apart


def test_later_day_edits_never_change_the_session(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press", "Dips"])
    session = started(client)
    push = ppl.day["Push"]
    lines = day_lines(client, push)
    ok(client.put(f"/api/days/{push}/lines", json={"line_ids": [lines[1]["id"], lines[0]["id"]]}))
    ok(client.post(f"/api/days/{push}/lines", json={"name": "Flyes"}), 201)
    ok(client.delete(f"/api/days/{push}/lines/{lines[0]['id']}"))
    assert on(client) == session


def test_session_writes_never_touch_the_day(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press", "Dips"])
    before = day_lines(client, ppl.day["Push"])
    curls = ok(client.post("/api/exercises", json={"name": "Curls"}), 201)["id"]
    session = started(client, lines=[{"day_line_id": before[1]["id"], "sets": [a_set()]}])
    lines = post_state(session)
    lines.append({"exercise_id": curls, "sets": [a_set()]})
    ok(write(client, session, lines))
    assert day_lines(client, ppl.day["Push"]) == before


# Switching Routines (§4.7)


def test_after_switching_routines_today_still_shows_the_other_routines_session(client: TestClient) -> None:
    Routine(client, Push=["Bench Press"])
    session = started(client)
    ul = Routine(client, "Upper Lower", Upper=["Rows"])
    ul.engage()
    assert on(client) == session
    assert suggested(client) == "Upper"
    lines = post_state(session)
    lines[0]["sets"].append(a_set())
    assert shape(ok(write(client, session, lines))) == [("Bench Press", ["135×5", "135×5"])]


# The Exercise library (§4.1)


def test_an_exercise_on_a_session_line_cannot_be_deleted_even_an_empty_line(client: TestClient) -> None:
    ppl = Routine(client, Push=["Bench Press", "Dips"])
    started(client)
    dips = day_lines(client, ppl.day["Push"])[1]
    ok(client.delete(f"/api/days/{ppl.day['Push']}/lines/{dips['id']}"))  # now only on the Session's empty Line
    refused(client.delete(f"/api/exercises/{dips['exercise']['id']}"), 409, "exercise_in_use")


# Refusal shapes


def test_the_schema_lists_only_the_refusals_each_route_can_give(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    codes = {
        (method, path): sorted(c for c in op["responses"] if c[0] in "45")
        for path, ops in paths.items()
        for method, op in ops.items()
        if op["tags"] == ["sessions"]
    }
    assert codes == {
        ("get", "/api/sessions/on/{date}"): ["422"],
        ("post", "/api/sessions"): ["404", "409", "422"],
        ("put", "/api/sessions/{session_id}"): ["404", "409", "422"],
    }
