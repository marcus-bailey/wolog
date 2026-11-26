"""Spec §4.1, LIB-2..LIB-4: rename, Retire / Un-retire, the Retired filter, and delete if unused."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from wolog import exercises


def create(client: TestClient, name: str) -> dict[str, Any]:
    res = client.post("/api/exercises", json={"name": name})
    assert res.status_code == 201, res.json()
    body: dict[str, Any] = res.json()
    return body


def change(client: TestClient, exercise_id: int, **fields: object):  # type: ignore[no-untyped-def]
    return client.patch(f"/api/exercises/{exercise_id}", json=fields)


def names(client: TestClient, query: str = "") -> list[str]:
    return [e["name"] for e in client.get(f"/api/exercises{query}").json()]


# Rename (LIB-2)


def test_rename_changes_the_label_of_the_same_identity(client: TestClient) -> None:
    bench = create(client, "Bench")
    res = change(client, bench["id"], name="  Bench    Press ")
    assert res.status_code == 200
    assert res.json() == {"id": bench["id"], "name": "Bench Press", "retired": False}
    assert client.get("/api/exercises").json() == [res.json()]


def test_rename_may_change_only_the_case_of_its_own_name(client: TestClient) -> None:
    bench = create(client, "bench press")
    res = change(client, bench["id"], name="Bench Press")
    assert (res.status_code, res.json()["name"]) == (200, "Bench Press")


@pytest.mark.parametrize("taken", ["Squat", "squat", "  SQUAT "])
def test_a_rename_colliding_with_another_exercise_is_refused(client: TestClient, taken: str) -> None:
    create(client, "Squat")
    bench = create(client, "Bench Press")
    res = change(client, bench["id"], name=taken)
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already an Exercise called “Squat”."}
    assert names(client) == ["Bench Press", "Squat"]  # no merge, nothing renamed


def test_a_rename_colliding_with_a_retired_exercise_is_refused(client: TestClient) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    bench = create(client, "Bench Press")
    res = change(client, bench["id"], name="squat")
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already a Retired Exercise called “Squat”."}
    assert names(client) == ["Bench Press", "Squat"]


@pytest.mark.parametrize("raw", ["", "   "])
def test_a_rename_to_an_empty_name_is_refused(client: TestClient, raw: str) -> None:
    bench = create(client, "Bench Press")
    res = change(client, bench["id"], name=raw)
    assert res.status_code == 422
    assert res.json() == {"code": "name_empty", "message": "An Exercise needs a name."}
    assert names(client) == ["Bench Press"]


def test_a_retired_exercise_can_be_renamed(client: TestClient) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    res = change(client, squat["id"], name="Back Squat")
    assert res.json() == {"id": squat["id"], "name": "Back Squat", "retired": True}


def test_a_retired_exercise_is_renamed_under_the_same_uniqueness_rule(client: TestClient) -> None:
    create(client, "Front Squat")
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    res = change(client, squat["id"], name="front squat")
    assert res.status_code == 409
    assert res.json()["code"] == "name_taken"
    assert client.get("/api/exercises?retired=true").json()[0]["name"] == "Squat"


def test_changing_an_unknown_exercise_is_refused(client: TestClient) -> None:
    res = change(client, 999, name="Squat")
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Exercise no longer exists."}


# Retire and Un-retire (LIB-3)


def test_retire_hides_the_exercise_from_pickers(client: TestClient) -> None:
    squat = create(client, "Squat")
    create(client, "Bench Press")
    res = change(client, squat["id"], retired=True)
    assert res.json() == {"id": squat["id"], "name": "Squat", "retired": True}
    assert names(client, "?retired=false") == ["Bench Press"]


def test_un_retire_restores_the_exercise_to_pickers(client: TestClient) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    res = change(client, squat["id"], retired=False)
    assert res.json() == {"id": squat["id"], "name": "Squat", "retired": False}
    assert names(client, "?retired=false") == ["Squat"]
    assert names(client, "?retired=true") == []


def test_the_library_can_list_retired_exercises_separately(client: TestClient) -> None:
    for name in ["Squat", "Bench Press", "Deadlift", "Curl"]:
        create(client, name)
    for e in client.get("/api/exercises").json():
        if e["name"] in ("Squat", "Curl"):
            change(client, e["id"], retired=True)
    assert names(client, "?retired=true") == ["Curl", "Squat"]
    assert names(client, "?retired=false") == ["Bench Press", "Deadlift"]
    listed = {e["name"]: e["retired"] for e in client.get("/api/exercises").json()}
    assert listed == {"Bench Press": False, "Curl": True, "Deadlift": False, "Squat": True}


def test_creating_a_name_that_matches_a_retired_exercise_is_refused_and_points_to_it(client: TestClient) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    res = client.post("/api/exercises", json={"name": " SQUAT "})
    assert res.status_code == 409
    assert res.json() == {
        "code": "name_retired",
        "message": "“Squat” is a Retired Exercise. Un-retire it to use it again.",
    }
    assert names(client) == ["Squat"]


def test_rename_and_retire_in_one_change(client: TestClient) -> None:
    squat = create(client, "Squat")
    res = change(client, squat["id"], name="Back Squat", retired=True)
    assert res.json() == {"id": squat["id"], "name": "Back Squat", "retired": True}


# Delete if unused (LIB-4)


@pytest.fixture
def line(engine: Engine) -> Iterator[None]:
    """A stand-in for a Line until Day Lines and Session Lines exist. Each Line table will
    reference its Exercise the same way: ON DELETE RESTRICT."""
    with engine.begin() as conn:
        conn.execute(
            text(
                "create table test_line (id int generated always as identity primary key,"
                " exercise_id int not null references exercise (id) on delete restrict)"
            )
        )
    yield
    with engine.begin() as conn:
        conn.execute(text("drop table test_line"))


def test_an_unused_exercise_can_be_deleted(client: TestClient) -> None:
    squat = create(client, "Squat")
    create(client, "Bench Press")
    res = client.delete(f"/api/exercises/{squat['id']}")
    assert res.status_code == 204
    assert names(client) == ["Bench Press"]


def test_a_retired_unused_exercise_can_be_deleted(client: TestClient) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    assert client.delete(f"/api/exercises/{squat['id']}").status_code == 204
    assert names(client) == []


def test_deleting_an_exercise_on_a_line_is_refused_and_suggests_retire(
    client: TestClient, engine: Engine, line: None
) -> None:
    squat = create(client, "Squat")
    with engine.begin() as conn:
        conn.execute(text("insert into test_line (exercise_id) values (:id)"), {"id": squat["id"]})
    res = client.delete(f"/api/exercises/{squat['id']}")
    assert res.status_code == 409
    assert res.json() == {
        "code": "exercise_in_use",
        "message": "“Squat” is on a Line, so it can’t be deleted. Retire it to hide it from pickers instead.",
    }
    assert names(client) == ["Squat"]
    assert change(client, squat["id"], retired=True).json()["retired"] is True  # Retire is still open to it


def test_deleting_an_unknown_exercise_is_refused(client: TestClient) -> None:
    res = client.delete("/api/exercises/999")
    assert res.status_code == 404
    assert res.json()["code"] == "not_found"


def test_a_deleted_name_is_free_again(client: TestClient) -> None:
    squat = create(client, "Squat")
    client.delete(f"/api/exercises/{squat['id']}")
    assert create(client, "squat")["id"] != squat["id"]


# Refusal shapes and races


class NameCheck:
    """Makes the next name check miss its holder, as if another request took the name between
    the check and the write. The unique index then catches the collision."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.misses = 0
        real = exercises._named

        def named(db: Session, name: str) -> exercises.Exercise | None:
            if self.misses:
                self.misses -= 1
                return None
            return real(db, name)

        monkeypatch.setattr(exercises, "_named", named)


@pytest.fixture
def name_check(monkeypatch: pytest.MonkeyPatch) -> NameCheck:
    return NameCheck(monkeypatch)


def test_a_create_that_loses_a_race_to_a_live_name_is_refused(client: TestClient, name_check: NameCheck) -> None:
    create(client, "Squat")
    name_check.misses = 1
    res = client.post("/api/exercises", json={"name": "squat"})
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already an Exercise called “Squat”."}


def test_a_create_that_loses_a_race_to_a_retired_name_points_to_it(client: TestClient, name_check: NameCheck) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    name_check.misses = 1
    res = client.post("/api/exercises", json={"name": "squat"})
    assert res.status_code == 409
    assert res.json() == {
        "code": "name_retired",
        "message": "“Squat” is a Retired Exercise. Un-retire it to use it again.",
    }


def test_a_rename_that_loses_a_race_to_a_retired_name_is_refused(client: TestClient, name_check: NameCheck) -> None:
    squat = create(client, "Squat")
    change(client, squat["id"], retired=True)
    bench = create(client, "Bench Press")
    name_check.misses = 1
    res = change(client, bench["id"], name="squat")
    assert res.json() == {"code": "name_taken", "message": "There is already a Retired Exercise called “Squat”."}
    assert names(client) == ["Bench Press", "Squat"]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/exercises/abc", {"name": "Squat"}),
        ("DELETE", "/api/exercises/abc", None),
        ("POST", "/api/exercises", {}),
        ("GET", "/api/exercises?retired=maybe", None),
    ],
)
def test_an_unreadable_request_is_refused_in_the_refusal_shape(
    client: TestClient, method: str, path: str, body: dict[str, str] | None
) -> None:
    res = client.request(method, path, json=body)
    assert res.status_code == 422
    assert res.json()["code"] == "invalid_request"
    assert res.json()["message"].startswith("That request isn’t valid.")


def test_the_schema_lists_only_the_refusals_each_route_can_give(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    codes = {
        (method, path): sorted(c for c in op["responses"] if c[0] in "45")
        for path, ops in paths.items()
        if path.startswith("/api/exercises")
        for method, op in ops.items()
    }
    assert codes == {
        ("get", "/api/exercises"): ["422"],
        ("post", "/api/exercises"): ["409", "422"],
        ("patch", "/api/exercises/{exercise_id}"): ["404", "409", "422"],
        ("delete", "/api/exercises/{exercise_id}"): ["404", "409", "422"],
    }
    refusal = {"$ref": "#/components/schemas/RefusalBody"}
    for (method, path), _ in codes.items():
        for c, response in paths[path][method]["responses"].items():
            if c[0] in "45":
                assert response["content"]["application/json"]["schema"] == refusal, (method, path, c)
