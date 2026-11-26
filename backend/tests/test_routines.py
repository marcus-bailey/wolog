"""Spec §4.2 (create, rename) and §4.7, RTN-1, RTN-2, RTN-5: Routines and the Engaged Routine."""

from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError


def create(client: TestClient, name: str) -> dict[str, Any]:
    res = client.post("/api/routines", json={"name": name})
    assert res.status_code == 201, res.json()
    body: dict[str, Any] = res.json()
    return body


def rename(client: TestClient, routine_id: int, name: str) -> httpx2.Response:
    return client.patch(f"/api/routines/{routine_id}", json={"name": name})


def engage(client: TestClient, routine_id: int) -> httpx2.Response:
    return client.post(f"/api/routines/{routine_id}/engage")


def listed(client: TestClient) -> list[tuple[str, bool]]:
    return [(r["name"], r["engaged"]) for r in client.get("/api/routines").json()]


# Create (RTN-1)


def test_there_are_no_routines_at_first(client: TestClient) -> None:
    assert client.get("/api/routines").json() == []


def test_a_routine_is_created_with_just_a_name(client: TestClient) -> None:
    res = client.post("/api/routines", json={"name": "  Upper   Lower "})
    assert res.status_code == 201
    assert res.json() == {"id": res.json()["id"], "name": "Upper Lower", "engaged": True}
    assert client.get("/api/routines").json() == [res.json()]


def test_the_first_routine_is_engaged_and_later_ones_are_not(client: TestClient) -> None:
    assert create(client, "PPL")["engaged"] is True
    assert create(client, "Upper Lower")["engaged"] is False
    assert create(client, "Full Body")["engaged"] is False
    assert listed(client) == [("Full Body", False), ("PPL", True), ("Upper Lower", False)]


@pytest.mark.parametrize("taken", ["PPL", "ppl", " pPl  "])
def test_a_name_colliding_after_normalisation_is_refused(client: TestClient, taken: str) -> None:
    create(client, "PPL")
    res = client.post("/api/routines", json={"name": taken})
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already a Routine called “PPL”."}
    assert listed(client) == [("PPL", True)]


@pytest.mark.parametrize("raw", ["", "   ", "\t\n"])
def test_an_empty_name_is_refused(client: TestClient, raw: str) -> None:
    res = client.post("/api/routines", json={"name": raw})
    assert res.status_code == 422
    assert res.json() == {"code": "name_empty", "message": "A Routine needs a name."}
    assert listed(client) == []


def test_routine_and_exercise_names_are_separate(client: TestClient) -> None:
    client.post("/api/exercises", json={"name": "Squat"})
    assert create(client, "Squat")["name"] == "Squat"


# Rename (RTN-2)


def test_rename_is_a_label_change(client: TestClient) -> None:
    ppl = create(client, "PPL")
    other = create(client, "Upper Lower")
    res = rename(client, ppl["id"], " Push  Pull Legs ")
    assert res.status_code == 200
    assert res.json() == {"id": ppl["id"], "name": "Push Pull Legs", "engaged": True}
    res = rename(client, other["id"], "UL")
    assert res.json() == {"id": other["id"], "name": "UL", "engaged": False}


def test_rename_may_change_only_the_case_of_its_own_name(client: TestClient) -> None:
    ppl = create(client, "ppl")
    assert rename(client, ppl["id"], "PPL").json()["name"] == "PPL"


@pytest.mark.parametrize("taken", ["Upper Lower", "upper lower", "  UPPER   LOWER "])
def test_a_rename_colliding_with_another_routine_is_refused(client: TestClient, taken: str) -> None:
    create(client, "Upper Lower")
    ppl = create(client, "PPL")
    res = rename(client, ppl["id"], taken)
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already a Routine called “Upper Lower”."}
    assert listed(client) == [("PPL", False), ("Upper Lower", True)]


def test_a_rename_to_an_empty_name_is_refused(client: TestClient) -> None:
    ppl = create(client, "PPL")
    res = rename(client, ppl["id"], "  ")
    assert res.status_code == 422
    assert res.json()["code"] == "name_empty"
    assert listed(client) == [("PPL", True)]


def test_a_rename_cannot_disengage(client: TestClient) -> None:
    ppl = create(client, "PPL")
    res = client.patch(f"/api/routines/{ppl['id']}", json={"name": "PPL", "engaged": False})
    assert res.json()["engaged"] is True
    assert listed(client) == [("PPL", True)]


@pytest.mark.parametrize("routine_id", [999, 0, -1, 2**31])
def test_renaming_an_unknown_routine_is_refused(client: TestClient, routine_id: int) -> None:
    res = rename(client, routine_id, "PPL")
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Routine no longer exists."}


# Engage (RTN-5, §4.7)


def test_engaging_another_routine_switches_to_it(client: TestClient) -> None:
    ppl = create(client, "PPL")
    ul = create(client, "Upper Lower")
    res = engage(client, ul["id"])
    assert res.status_code == 200
    assert res.json() == {"id": ul["id"], "name": "Upper Lower", "engaged": True}
    assert listed(client) == [("PPL", False), ("Upper Lower", True)]
    assert engage(client, ppl["id"]).json()["engaged"] is True
    assert listed(client) == [("PPL", True), ("Upper Lower", False)]


def test_engaging_the_engaged_routine_changes_nothing(client: TestClient) -> None:
    ppl = create(client, "PPL")
    create(client, "Upper Lower")
    res = engage(client, ppl["id"])
    assert (res.status_code, res.json()["engaged"]) == (200, True)
    assert listed(client) == [("PPL", True), ("Upper Lower", False)]


def test_engaging_an_unknown_routine_is_refused_and_changes_nothing(client: TestClient) -> None:
    create(client, "PPL")
    for routine_id in (999, 0, 2**31):
        res = engage(client, routine_id)
        assert res.status_code == 404
        assert res.json()["code"] == "not_found"
    assert listed(client) == [("PPL", True)]


def test_switches_are_not_recorded(client: TestClient) -> None:
    """Switching back and forth leaves the Routines as they were, but for which one is engaged."""
    ppl = create(client, "PPL")
    ul = create(client, "Upper Lower")
    before = client.get("/api/routines").json()
    for routine_id in (ul["id"], ppl["id"], ul["id"], ppl["id"]):
        engage(client, routine_id)
    assert client.get("/api/routines").json() == before


def test_there_is_no_way_to_disengage(client: TestClient) -> None:
    ppl = create(client, "PPL")
    assert client.delete(f"/api/routines/{ppl['id']}/engage").status_code == 405
    assert client.post("/api/routines/engage").status_code in (404, 405)
    assert listed(client) == [("PPL", True)]


# The engaged invariant under concurrent writes


def test_concurrent_first_creates_engage_exactly_one(client: TestClient) -> None:
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda i: client.post("/api/routines", json={"name": f"R{i}"}), range(8)))
    assert [r.status_code for r in results] == [201] * 8
    assert sum(engaged for _, engaged in listed(client)) == 1


def test_concurrent_switches_leave_exactly_one_engaged(client: TestClient) -> None:
    ids = [create(client, f"R{i}")["id"] for i in range(6)]
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda i: engage(client, i), ids * 3))
    assert all(r.status_code == 200 for r in results)
    assert sum(engaged for _, engaged in listed(client)) == 1


def test_concurrent_creates_of_one_name_make_one_routine(client: TestClient) -> None:
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: client.post("/api/routines", json={"name": "PPL"}), range(6)))
    assert sorted(r.status_code for r in results) == [201] + [409] * 5
    assert listed(client) == [("PPL", True)]


# The engaged invariant in the database, below the API


def run(engine: Engine, *statements: str) -> None:
    with engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))


def test_the_database_refuses_a_second_engaged_routine(client: TestClient, engine: Engine) -> None:
    create(client, "PPL")
    with pytest.raises(IntegrityError, match="routine_one_engaged"):
        run(engine, "insert into routine (name, engaged) values ('Upper Lower', true)")


def test_the_database_refuses_routines_with_none_engaged(client: TestClient, engine: Engine) -> None:
    with pytest.raises(IntegrityError, match="exactly one is engaged"):
        run(engine, "insert into routine (name) values ('PPL')")
    create(client, "PPL")
    with pytest.raises(IntegrityError, match="exactly one is engaged"):
        run(engine, "update routine set engaged = false")
    create(client, "Upper Lower")
    with pytest.raises(IntegrityError, match="exactly one is engaged"):
        run(engine, "delete from routine where engaged")
    assert listed(client) == [("PPL", True), ("Upper Lower", False)]


def test_the_database_allows_a_switch_within_one_transaction(client: TestClient, engine: Engine) -> None:
    create(client, "PPL")
    create(client, "Upper Lower")
    run(
        engine,
        "update routine set engaged = false where engaged",
        "update routine set engaged = true where name = 'Upper Lower'",
    )
    assert listed(client) == [("PPL", False), ("Upper Lower", True)]


def test_the_database_allows_no_routines_at_all(client: TestClient, engine: Engine) -> None:
    create(client, "PPL")
    create(client, "Upper Lower")
    run(engine, "delete from routine")
    assert listed(client) == []
    assert create(client, "Full Body")["engaged"] is True  # back to first run


# Refusal shapes


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/routines/abc", {"name": "PPL"}),
        ("POST", "/api/routines/abc/engage", None),
        ("POST", "/api/routines", {}),
        ("PATCH", "/api/routines/1", {}),
    ],
)
def test_an_unreadable_request_is_refused_in_the_refusal_shape(
    client: TestClient, method: str, path: str, body: dict[str, str] | None
) -> None:
    res = client.request(method, path, json=body)
    assert res.status_code == 422
    assert res.json()["code"] == "invalid_request"


def test_the_schema_lists_only_the_refusals_each_route_can_give(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    codes = {
        (method, path): sorted(c for c in op["responses"] if c[0] in "45")
        for path, ops in paths.items()
        for method, op in ops.items()
        if op["tags"] == ["routines"]
    }
    assert codes == {
        ("get", "/api/routines"): [],
        ("post", "/api/routines"): ["409", "422"],
        ("patch", "/api/routines/{routine_id}"): ["404", "409", "422"],
        ("post", "/api/routines/{routine_id}/engage"): ["404", "422"],
    }
