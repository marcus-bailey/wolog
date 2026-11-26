"""API tests run against a real Postgres: a fresh `wolog_test` database, built by the
migrations (never create_all), emptied between tests.

TEST_DATABASE_URL points at it; the default is the local compose Postgres (`docker compose up -d postgres`).
"""

import os
from collections.abc import Iterator

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, make_url, text

from wolog.app import create_app

URL = make_url(os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://wolog:wolog@localhost:5462/wolog_test"))
BACKEND = os.path.dirname(os.path.dirname(__file__))


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    admin = create_engine(URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'drop database if exists "{URL.database}" with (force)'))
        conn.execute(text(f'create database "{URL.database}"'))
    admin.dispose()

    config = Config(os.path.join(BACKEND, "alembic.ini"))
    config.attributes["url"] = URL.render_as_string(hide_password=False)
    config.attributes["configure_logger"] = False
    command.upgrade(config, "head")

    eng = create_engine(URL)
    yield eng
    eng.dispose()


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    with engine.begin() as conn:
        tables = conn.scalars(
            text("select tablename from pg_tables where schemaname = 'public' and tablename <> 'alembic_version'")
        ).all()
        if tables:
            conn.execute(text(f"truncate {', '.join(tables)} restart identity cascade"))
    with TestClient(create_app(engine)) as c:
        yield c
