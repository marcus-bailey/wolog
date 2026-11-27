"""Spec §4.4 Backfill and Skip gap, §4.5 Cursor effect: TDY-4."""

from typing import Any

import httpx2
from fastapi.testclient import TestClient

from tests.test_sessions import TODAY, Routine, _skip_body, a_set, days_ago, ok, on, refused, suggested


def as_of(client: TestClient, date: str) -> dict[str, Any] | None:
    """Up next's suggestion as of a date, as the logger sees it for a Session on that date."""
    s: dict[str, Any] | None = ok(client.get("/api/up-next", params={"on": date}))["suggestion"]
    return s


def day_as_of(client: TestClient, date: str) -> str | None:
    s = as_of(client, date)
    return None if s is None else str(s["day_name"])


def log(client: TestClient, date: str, day_id: int | None = None) -> httpx2.Response:
    """Save a first Set on `date` as the logger would: on the suggestion as of that date (or `day_id`
    picked instead), every Line of that Day, one Set on the first."""
    now = ok(client.get("/api/up-next", params={"on": date}))
    day = day_id if day_id is not None else now["suggestion"]["day_id"]
    seen = [line["id"] for line in ok(client.get(f"/api/days/{day}"))["lines"]]
    return client.post(
        "/api/sessions",
        json={
            "date": date,
            "today": TODAY.isoformat(),
            "routine_id": now["routine"]["id"],
            "turn_id": now["suggestion"]["turn_id"],
            **({} if day_id is None else {"day_id": day_id}),
            "day_lines": seen,
            "lines": [{"day_line_id": dl, "sets": [a_set()] if i == 0 else []} for i, dl in enumerate(seen)],
        },
    )


def logged(client: TestClient, date: str, day_id: int | None = None) -> dict[str, Any]:
    body: dict[str, Any] = ok(log(client, date, day_id), 201)
    return body


def skip(client: TestClient, date: str) -> None:
    ok(client.post("/api/skips", json={**_skip_body(client), "date": date}), 201)


def abcd(client: TestClient) -> Routine:
    return Routine(client, A=["Bench Press"], B=["Rows"], C=["Squat"], D=["Curls"])


# Pre-selection as of the date (§4.4 Backfill)


def test_up_next_without_a_date_is_the_live_suggestion(client: TestClient) -> None:
    abcd(client)
    logged(client, days_ago(3))  # A
    assert day_as_of(client, TODAY.isoformat()) == suggested(client) == "B"


def test_a_backfill_uses_the_latest_session_before_its_date_then_skips_up_to_it(client: TestClient) -> None:
    abcd(client)
    logged(client, days_ago(8))  # A
    skip(client, days_ago(6))  # B
    logged(client, days_ago(3))  # C
    assert suggested(client) == "D"

    assert day_as_of(client, days_ago(7)) == "B"  # after the Session of A
    assert day_as_of(client, days_ago(6)) == "C"  # the Skip on that date counts
    assert day_as_of(client, days_ago(4)) == "C"
    assert day_as_of(client, days_ago(9)) == "A"  # nothing earlier: the first Turn


def test_a_backfill_pins_the_suggestion_as_of_its_date(client: TestClient) -> None:
    abcd(client)
    logged(client, days_ago(8))  # A
    skip(client, days_ago(6))  # B
    logged(client, days_ago(3))  # C

    backfill = logged(client, days_ago(4))
    assert backfill["day"]["name"] == "C"
    assert backfill["turn_id"] == as_of(client, days_ago(5))["turn_id"]  # type: ignore[index]


def test_a_backfill_with_a_stale_suggestion_is_refused(client: TestClient) -> None:
    ppl = abcd(client)
    logged(client, days_ago(3))  # A
    live = ok(client.get("/api/up-next"))["suggestion"]  # B
    res = client.post(
        "/api/sessions",
        json={
            "date": days_ago(5),
            "today": TODAY.isoformat(),
            "routine_id": ppl.id,
            "turn_id": live["turn_id"],
            "day_lines": [line["id"] for line in ok(client.get(f"/api/days/{ppl.day['B']}"))["lines"]],
            "lines": [{"name": "Rows", "sets": [a_set()]}],
        },
    )
    assert "A" in refused(res, 409, "suggestion_changed")


def test_picking_another_day_on_a_backfill_counts_from_the_suggestion_as_of_its_date(client: TestClient) -> None:
    ppl = Routine(client, A=["Bench Press"], B=["Rows"], C=["Squat"])
    logged(client, days_ago(6))  # A
    logged(client, days_ago(2))  # B
    session = logged(client, days_ago(4), day_id=ppl.day["A"])  # as of then: B suggested; A picked
    assert session["day"]["name"] == "A"
    assert session["turn_id"] == ppl.turns()[0]


def test_saving_a_backfill_never_moves_the_live_cursor(client: TestClient) -> None:
    ppl = abcd(client)
    logged(client, days_ago(3))  # A
    assert suggested(client) == "B"
    backfill = logged(client, days_ago(6))  # A again, as of then
    assert suggested(client) == "B"

    # Changing the backfill's Day doesn't move it either.
    res = client.put(
        f"/api/sessions/{backfill['id']}",
        json={
            "version": backfill["version"],
            "day_id": ppl.day["C"],
            "lines": [{"id": line["id"], "sets": line["sets"]} for line in backfill["lines"]],
        },
    )
    ok(res)
    assert suggested(client) == "B"


# The Skip gap (§4.4)


def test_a_new_session_in_the_skip_gap_is_refused(client: TestClient) -> None:
    abcd(client)
    logged(client, days_ago(6))  # A
    skip(client, days_ago(4))  # B
    skip(client, days_ago(2))  # C

    for date in (days_ago(5), days_ago(4), days_ago(3)):
        message = refused(log(client, date), 409, "date_in_skip_gap")
        assert "before" in message and "on or after" in message
        assert on(client, date) is None
    refused(log(client, days_ago(6)), 409, "session_exists")


def test_a_new_session_before_the_gap_or_on_or_after_the_last_skip_is_allowed(client: TestClient) -> None:
    abcd(client)
    logged(client, days_ago(6))  # A
    skip(client, days_ago(4))  # B
    skip(client, days_ago(2))  # C

    assert logged(client, days_ago(7))["day"]["name"] == "A"  # a backfill: nothing before it
    # On the last Skip's date: it replaces that Skip, pinning the suggestion as it stood before.
    assert logged(client, days_ago(2))["day"]["name"] == "D"
    assert suggested(client) == "A"


def test_with_skips_and_no_session_a_new_session_before_the_last_skip_is_refused(client: TestClient) -> None:
    abcd(client)
    skip(client, days_ago(3))  # A

    message = refused(log(client, days_ago(5)), 409, "date_in_skip_gap")
    assert "on or after" in message
    assert logged(client, days_ago(1))["day"]["name"] == "B"


def test_without_skips_there_is_no_gap(client: TestClient) -> None:
    abcd(client)
    logged(client, days_ago(4))  # A
    assert logged(client, days_ago(2))["day"]["name"] == "B"
    assert logged(client, days_ago(3))["day"]["name"] == "B"  # backfill, as of then: after A


def test_sessions_inside_the_gap_stay_editable_and_deletable(client: TestClient) -> None:
    abcd(client)
    session = logged(client, days_ago(6))  # A, the start of the gap once Skips follow
    skip(client, days_ago(4))

    lines = [{"id": line["id"], "sets": [*line["sets"], a_set(3, "155")]} for line in session["lines"]]
    edited = ok(client.put(f"/api/sessions/{session['id']}", json={"version": session["version"], "lines": lines}))
    assert len(edited["lines"][0]["sets"]) == 2
    assert client.delete(f"/api/sessions/{session['id']}").status_code == 204
