"""The database: one engine per process, one session (one transaction) per request."""

import os
from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import DeclarativeBase, Session


class Base(DeclarativeBase):
    pass


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("Set DATABASE_URL, e.g. postgresql+psycopg://wolog:wolog@localhost:5462/wolog")
    return url


def make_engine(url: str) -> Engine:
    return create_engine(url, pool_pre_ping=True)


def get_session(request: Request) -> Iterator[Session]:
    """Each write is a single transaction: committed when the handler returns, rolled back if it raises.

    Depend on it with scope="function" so the commit happens before the response is sent;
    otherwise a client could be told a write succeeded before (or without) it committing.
    """
    engine: Engine = request.app.state.engine
    with Session(engine) as session, session.begin():
        yield session
