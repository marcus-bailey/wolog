"""Spec §4.9 History: HST-1."""

from typing import Any

from fastapi.testclient import TestClient

from tests.test_sessions import TODAY, Routine, _skip_body, days_ago, ok, started


def history(client: TestClient) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = ok(client.get("/api/history"))
    return rows


def rows(client: TestClient) -> list[tuple[str, str, str, str]]:
    return [(r["kind"], r["date"], r["routine"]["name"], r["day"]["name"]) for r in history(client)]


def skip(client: TestClient, date: str) -> None:
    ok(client.post("/api/skips", json={**_skip_body(client), "date": date}), 201)


def test_nothing_logged_is_an_empty_history(client: TestClient) -> None:
    Routine(client, A=["Squat"])
    assert history(client) == []


def test_sessions_and_skips_of_every_routine_newest_first(client: TestClient) -> None:
    ppl = Routine(client, "PPL", Push=["Bench Press"], Pull=["Rows"], Legs=["Squat"])
    skip(client, days_ago(6))  # Push
    started(client, days_ago(4))  # Pull
    ul = Routine(client, "Upper Lower", Upper=["Overhead Press"], Lower=["Deadlift"])
    ul.engage()
    started(client, days_ago(3))  # Upper
    skip(client, days_ago(1))  # Lower
    skip(client, days_ago(1))  # Upper, the same date
    ppl.engage()
    skip(client, days_ago(1))  # Legs, the same date, another Routine
    started(client)  # Push, today

    # Rest dates (days_ago 5 and 2) are not listed.
    assert rows(client) == [
        ("session", TODAY.isoformat(), "PPL", "Push"),
        ("skip", days_ago(1), "PPL", "Legs"),
        ("skip", days_ago(1), "Upper Lower", "Upper"),
        ("skip", days_ago(1), "Upper Lower", "Lower"),
        ("session", days_ago(3), "Upper Lower", "Upper"),
        ("session", days_ago(4), "PPL", "Pull"),
        ("skip", days_ago(6), "PPL", "Push"),
    ]


def test_a_row_names_its_session_or_skip_with_ids(client: TestClient) -> None:
    ppl = Routine(client, "PPL", Push=["Bench Press"], Pull=["Rows"])
    skip(client, days_ago(2))
    session = started(client, days_ago(1))

    first, second = history(client)
    assert first == {
        "kind": "session",
        "id": session["id"],
        "date": days_ago(1),
        "routine": {"id": ppl.id, "name": "PPL"},
        "day": {"id": ppl.day["Pull"], "name": "Pull"},
    }
    assert second["kind"] == "skip"
    assert second["day"] == {"id": ppl.day["Push"], "name": "Push"}


def test_rows_use_current_names(client: TestClient) -> None:
    ppl = Routine(client, "PPL", Push=["Bench Press"], Pull=["Rows"])
    skip(client, days_ago(2))
    started(client, days_ago(1))
    ok(client.patch(f"/api/routines/{ppl.id}", json={"name": "Push Pull"}))
    ok(client.patch(f"/api/days/{ppl.day['Pull']}", json={"name": "Back"}))
    ok(client.patch(f"/api/days/{ppl.day['Push']}", json={"name": "Chest"}))

    assert rows(client) == [
        ("session", days_ago(1), "Push Pull", "Back"),
        ("skip", days_ago(2), "Push Pull", "Chest"),
    ]


def test_history_names_the_day_when_the_pinned_turn_is_gone(client: TestClient) -> None:
    ppl = Routine(client, "PPL", Push=["Bench Press"], Pull=["Rows"])
    skip(client, days_ago(2))  # Push
    started(client, days_ago(1))  # Pull
    for turn in ppl.turns():
        ok(client.delete(f"/api/routines/{ppl.id}/turns/{turn}"))

    assert rows(client) == [
        ("session", days_ago(1), "PPL", "Pull"),
        ("skip", days_ago(2), "PPL", "Push"),
    ]
