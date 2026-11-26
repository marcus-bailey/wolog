from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from wolog.app import create_app


def test_healthy_when_the_database_answers(client: TestClient) -> None:
    res = client.get("/health")
    assert (res.status_code, res.json()) == (200, {"status": "ok"})


def test_unhealthy_when_the_database_does_not() -> None:
    nowhere = create_engine("postgresql+psycopg://wolog:wolog@127.0.0.1:1/wolog", connect_args={"connect_timeout": 1})
    with TestClient(create_app(nowhere)) as c:
        res = c.get("/health")
    assert (res.status_code, res.json()) == (503, {"status": "unavailable"})


def test_the_openapi_schema_is_served(client: TestClient) -> None:
    assert "/api/exercises" in client.get("/api/openapi.json").json()["paths"]
