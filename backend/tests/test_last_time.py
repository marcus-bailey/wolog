"""Spec §4.8 Last-time and prefill: LOG-7, and LOG-2's prefill source."""

from typing import Any

from fastapi.testclient import TestClient

from tests.test_sessions import TODAY, Routine, a_set, days_ago, ok, on, post_state, refused, started, write


def last_time(client: TestClient, before: str | None = None, **by: Any) -> dict[str, Any]:
    body: dict[str, Any] = ok(client.get("/api/last-time", params={"before": before or TODAY.isoformat(), **by}))
    return body


def exercise_id(client: TestClient, name: str) -> int:
    found = [e["id"] for e in ok(client.get("/api/exercises")) if e["name"] == name]
    assert found, name
    return int(found[0])


def logged(client: TestClient, date: str, **lines: list[dict[str, Any]]) -> dict[str, Any]:
    """A Session on `date` of extra Lines by Exercise name (repeat a name with a trailing _n)."""
    return started(client, date, lines=[{"name": name.split("_")[0], "sets": sets} for name, sets in lines.items()])


def shown(answer: dict[str, Any]) -> tuple[str, list[list[str]]] | None:
    """Last-time's date and its Sets per Line as "weight×reps" (w for Warmup, +note)."""
    last = answer["last_time"]
    if last is None:
        return None

    def one(s: dict[str, Any]) -> str:
        return f"{s['weight']}×{s['reps']}{'w' if s['warmup'] else ''}{'+' + s['note'] if s['note'] else ''}"

    return last["date"], [[one(s) for s in line["sets"]] for line in last["lines"]]


def test_last_time_is_the_latest_earlier_session_with_a_set_of_the_exercise(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, days_ago(9), Squat=[a_set(5, "200")])
    logged(client, days_ago(5), Squat=[a_set(5, "225")])
    logged(client, days_ago(1), Squat=[a_set(5, "245")])
    squat = exercise_id(client, "Squat")

    assert shown(last_time(client, exercise_id=squat)) == (days_ago(1), [["245×5"]])
    # Strictly before the Session being logged: not that date's own Session, nor any later one.
    assert shown(last_time(client, days_ago(1), exercise_id=squat)) == (days_ago(5), [["225×5"]])
    assert shown(last_time(client, days_ago(4), exercise_id=squat)) == (days_ago(5), [["225×5"]])


def test_sessions_with_no_set_of_the_exercise_are_walked_past(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, days_ago(6), Squat=[a_set(5, "200")])
    logged(client, days_ago(4), Bench=[a_set(5, "135")])  # no Line of it
    logged(client, days_ago(2), Bench=[a_set(5, "140")], Squat=[])  # only an empty Line of it

    assert shown(last_time(client, exercise_id=exercise_id(client, "Squat"))) == (days_ago(6), [["200×5"]])


def test_any_routine_or_day_counts_and_neither_is_shown(client: TestClient) -> None:
    ppl = Routine(client, "PPL", Legs=["Squat"])
    ppl.engage()
    started(client, days_ago(5))
    other = Routine(client, "Other", Full=[])
    other.engage()
    logged(client, days_ago(2), Squat=[a_set(3, "250")])

    answer = last_time(client, exercise_id=exercise_id(client, "Squat"))
    assert shown(answer) == (days_ago(2), [["250×3"]])
    assert set(answer["last_time"]) == {"date", "lines"}
    assert shown(last_time(client, days_ago(2), exercise_id=exercise_id(client, "Squat"))) == (days_ago(5), [["135×5"]])


def test_every_set_in_recorded_order_grouped_by_line_with_warmups_and_notes(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    session = logged(
        client,
        days_ago(3),
        Squat=[a_set(8, "135", warmup=True), a_set(5, "225", note="grindy")],
        Bench=[a_set(5, "135")],
        Squat_2=[a_set(10, "185"), a_set(10, "185", note="paused")],
    )
    # Reorder within a Line after the fact: the recorded order is the Line's order now.
    lines = post_state(session)
    lines[0]["sets"].reverse()
    ok(write(client, session, lines))

    answer = last_time(client, exercise_id=exercise_id(client, "Squat"))
    assert shown(answer) == (days_ago(3), [["225×5+grindy", "135×8w"], ["185×10", "185×10+paused"]])
    assert set(answer["last_time"]["lines"][0]["sets"][0]) == {"id", "reps", "weight", "warmup", "note"}


def test_nothing_earlier_answers_null_with_no_prefill(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, TODAY.isoformat(), Squat=[a_set()])

    assert last_time(client, exercise_id=exercise_id(client, "Squat")) == {
        "exercise_id": exercise_id(client, "Squat"),
        "last_time": None,
        "prefill": None,
    }


def test_prefill_is_last_times_first_working_set(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(
        client,
        days_ago(2),
        Squat=[a_set(10, "45", warmup=True)],
        Squat_2=[a_set(8, "135", warmup=True), a_set(5, "225", note="top"), a_set(5, "205")],
    )

    assert last_time(client, exercise_id=exercise_id(client, "Squat"))["prefill"] == {"reps": 5, "weight": "225"}


def test_prefill_is_last_times_first_set_when_it_has_no_working_set(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, days_ago(2), Squat=[a_set(10, "45", warmup=True), a_set(8, "95", warmup=True)])

    assert last_time(client, exercise_id=exercise_id(client, "Squat"))["prefill"] == {"reps": 10, "weight": "45"}


def test_last_time_follows_the_exercise_through_rename_and_retire(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, days_ago(2), Squat=[a_set(5, "225")])
    squat = exercise_id(client, "Squat")
    ok(client.patch(f"/api/exercises/{squat}", json={"name": "Back Squat", "retired": True}))

    assert shown(last_time(client, exercise_id=squat)) == (days_ago(2), [["225×5"]])
    assert last_time(client, name="back  squat")["exercise_id"] == squat


def test_last_time_is_computed_live_from_current_data(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    older = logged(client, days_ago(4), Squat=[a_set(5, "200")])
    newer = logged(client, days_ago(2), Squat=[a_set(5, "225")])
    squat = exercise_id(client, "Squat")

    lines = post_state(newer)
    lines[0]["sets"][0]["weight"] = "230"
    ok(write(client, newer, lines))
    assert shown(last_time(client, exercise_id=squat)) == (days_ago(2), [["230×5"]])

    assert client.delete(f"/api/sessions/{newer['id']}").status_code == 204
    assert shown(last_time(client, exercise_id=squat)) == (days_ago(4), [["200×5"]])

    ok(write(client, older, [{"id": older["lines"][0]["id"], "sets": []}, {"name": "Bench", "sets": [a_set()]}]))
    assert last_time(client, exercise_id=squat)["last_time"] is None


def test_skips_are_ignored(client: TestClient) -> None:
    ppl = Routine(client, A=[])
    ppl.engage()
    logged(client, days_ago(3), Squat=[a_set(5, "225")])
    now = ok(client.get("/api/up-next"))
    ok(
        client.post(
            "/api/skips",
            json={
                "routine_id": ppl.id,
                "turn_id": now["suggestion"]["turn_id"],
                "date": days_ago(1),
                "today": TODAY.isoformat(),
            },
        ),
        201,
    )

    assert shown(last_time(client, exercise_id=exercise_id(client, "Squat"))) == (days_ago(3), [["225×5"]])


def test_an_exercise_can_be_named_as_typed(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, days_ago(2), Squat=[a_set(5, "225")])

    answer = last_time(client, name="  squat ")
    assert answer["exercise_id"] == exercise_id(client, "Squat")
    assert shown(answer) == (days_ago(2), [["225×5"]])
    # A name no Exercise has yet has no history.
    assert last_time(client, name="Lunge") == {"exercise_id": None, "last_time": None, "prefill": None}
    assert on(client, days_ago(2)) is not None


def test_the_exercise_is_named_by_id_or_by_name_not_both(client: TestClient) -> None:
    Routine(client, A=[]).engage()
    logged(client, days_ago(2), Squat=[a_set()])
    squat = exercise_id(client, "Squat")

    params: dict[str, str | int] = {"before": TODAY.isoformat()}
    refused(client.get("/api/last-time", params=params), 422, "invalid_request")
    both: dict[str, str | int] = {**params, "exercise_id": squat, "name": "Squat"}
    refused(client.get("/api/last-time", params=both), 422, "invalid_request")
    refused(client.get("/api/last-time", params={**params, "exercise_id": 999}), 404, "not_found")
    refused(client.get("/api/last-time", params={**params, "exercise_id": 2**40}), 404, "not_found")
    refused(client.get("/api/last-time", params={"exercise_id": squat}), 422, "invalid_request")
