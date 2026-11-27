"""History (spec §4.9; HST-1): one list of Sessions and Skips across all Routines, newest first.

Each row names its date, Routine and Day by their current names. The Day comes from the row's own
Day pin, never from its Turn, so it is named even when the pinned Turn is gone. Rest dates hold no
row. Within a date a Session comes first, then that date's Skips, the latest first.
"""

import datetime as dt
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import literal, select, union_all
from sqlalchemy.orm import Session

from wolog.days import Day
from wolog.db import get_session
from wolog.pins import SessionRecord, Skip
from wolog.routines import Routine
from wolog.sessions import Named


class HistoryRow(BaseModel):
    """A Session or a Skip: `id` is the Session's or the Skip's."""

    kind: Literal["session", "skip"]
    id: int
    date: dt.date
    routine: Named
    day: Named


router = APIRouter(tags=["history"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


@router.get("/api/history")
def get_history(db: DbSession) -> list[HistoryRow]:
    """Every Session and Skip, newest first."""
    pins = union_all(
        select(
            literal("session").label("kind"),
            literal(0).label("rank"),
            SessionRecord.id,
            SessionRecord.date,
            SessionRecord.routine_id,
            SessionRecord.day_id,
        ),
        select(literal("skip"), literal(1), Skip.id, Skip.date, Skip.routine_id, Skip.day_id),
    ).subquery()
    rows = db.execute(
        select(pins.c.kind, pins.c.id, pins.c.date, Routine.id, Routine.name, Day.id, Day.name)
        .join(Routine, Routine.id == pins.c.routine_id)
        .join(Day, Day.id == pins.c.day_id)
        .order_by(pins.c.date.desc(), pins.c.rank, pins.c.id.desc())
    ).all()
    return [
        HistoryRow(
            kind=kind,
            id=row_id,
            date=date,
            routine=Named(id=routine_id, name=routine_name),
            day=Named(id=day_id, name=day_name),
        )
        for kind, row_id, date, routine_id, routine_name, day_id, day_name in rows
    ]
