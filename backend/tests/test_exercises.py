"""Spec §3 Normalisation and §4.1: the library lists and creates Exercises."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import SessionTransaction
from starlette.types import Message, Receive, Scope, Send

from wolog.app import create_app
from wolog.names import normalise


def create(client: TestClient, name: str):  # type: ignore[no-untyped-def]
    return client.post("/api/exercises", json={"name": name})


def test_the_library_starts_empty(client: TestClient) -> None:
    assert client.get("/api/exercises").json() == []


def test_create_then_list(client: TestClient) -> None:
    res = create(client, "Bench Press")
    assert res.status_code == 201
    assert res.json() == {"id": res.json()["id"], "name": "Bench Press", "retired": False}
    assert client.get("/api/exercises").json() == [res.json()]


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("  Bench Press  ", "Bench Press"),
        ("Bench    Press", "Bench Press"),
        ("\tBench \n Press ", "Bench Press"),
        ("bench press", "bench press"),
    ],
)
def test_the_stored_label_is_the_collapsed_form(client: TestClient, raw: str, stored: str) -> None:
    assert create(client, raw).json()["name"] == stored


def test_normalise() -> None:
    assert normalise("  a   b \t c ") == "a b c"
    assert normalise(" \n\t ") == ""


@pytest.mark.parametrize("raw", ["", "   ", "\t\n"])
def test_an_empty_name_is_refused(client: TestClient, raw: str) -> None:
    res = create(client, raw)
    assert res.status_code == 422
    assert res.json() == {"code": "name_empty", "message": "An Exercise needs a name."}
    assert client.get("/api/exercises").json() == []


@pytest.mark.parametrize("again", ["Bench Press", "bench press", "  BENCH   press "])
def test_a_colliding_name_is_refused(client: TestClient, again: str) -> None:
    create(client, "Bench Press")
    res = create(client, again)
    assert res.status_code == 409
    assert res.json() == {"code": "name_taken", "message": "There is already an Exercise called “Bench Press”."}
    assert [e["name"] for e in client.get("/api/exercises").json()] == ["Bench Press"]


def test_the_database_enforces_uniqueness_case_insensitively(client: TestClient, engine: Engine) -> None:
    create(client, "Squat")
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("insert into exercise (name) values ('SQUAT')"))


def test_the_database_refuses_an_empty_name(client: TestClient, engine: Engine) -> None:
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("insert into exercise (name) values ('')"))


def test_the_list_is_alphabetical_ignoring_case(client: TestClient) -> None:
    for name in ["squat", "Bench Press", "deadlift"]:
        create(client, name)
    assert [e["name"] for e in client.get("/api/exercises").json()] == ["Bench Press", "deadlift", "squat"]


def test_the_write_commits_before_the_response(
    client: TestClient, engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The client must not be told a write succeeded before it has committed."""
    events: list[str] = []
    real_commit = SessionTransaction.commit

    def commit(self: SessionTransaction, _to_root: bool = False) -> None:
        events.append("commit")
        real_commit(self, _to_root)

    monkeypatch.setattr(SessionTransaction, "commit", commit)
    app = create_app(engine)

    async def recording(scope: Scope, receive: Receive, send: Send) -> None:
        async def record(message: Message) -> None:
            if message["type"] == "http.response.start":
                events.append(f"response {message['status']}")
            await send(message)

        await app(scope, receive, record)

    with TestClient(recording) as c:
        c.post("/api/exercises", json={"name": "Squat"})
    assert "commit" in events
    assert events[-1] == "response 201", events  # nothing commits after the client hears back
