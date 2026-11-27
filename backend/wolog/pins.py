"""Pins and the cursor (spec §3 Pins, §4.4 Cursor).

Sessions and Skips pin a Routine, a Day and a Turn. The Turn pin may dangle: when the Turn is
removed, the database sets turn_id to null and the pin holds no Turn.

The cursor of a Routine is the Turn of its latest pin (by date, then order within the date) that
still holds a Turn. Walking back past pins whose Turn is gone is just skipping nulls. Taking Sessions
and Skips together in date order is the same as §4.4's "the latest Session, then later Skips",
because a date can't hold both a Session and Skips of one Routine.

The Session's own table lives here, beside the Skip's, because the cursor reads both; its Lines and
Sets are in `wolog.sessions`.
"""

import datetime as dt

from sqlalchemy import (
    Date,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Select,
    UniqueConstraint,
    select,
    union_all,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from wolog.db import Base


class Skip(Base):
    """A dated pass of the then-suggested Turn. It pins its Routine and Day; its Turn may dangle (null)."""

    __tablename__ = "skip"
    __table_args__ = (
        ForeignKeyConstraint(
            ["day_id", "routine_id"], ["day.id", "day.routine_id"], name="skip_day_of_routine", ondelete="RESTRICT"
        ),
        ForeignKeyConstraint(
            ["turn_id", "day_id"], ["turn.id", "turn.day_id"], name="skip_turn_of_day", ondelete="SET NULL (turn_id)"
        ),
        Index("skip_routine_date", "routine_id", "date", "id"),
        Index("skip_turn", "turn_id"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    date: Mapped[dt.date] = mapped_column(Date)
    routine_id: Mapped[int] = mapped_column(ForeignKey("routine.id", ondelete="RESTRICT"))
    day_id: Mapped[int]
    turn_id: Mapped[int | None]


class SessionRecord(Base):
    """A Session: a dated record of work on a Day of one Routine. At most one per date across all
    Routines. It pins its Routine and Day; its Turn may dangle (null). Its Lines are `SessionLine`s."""

    __tablename__ = "session"
    __table_args__ = (
        UniqueConstraint("date", name="session_one_per_date"),
        ForeignKeyConstraint(
            ["day_id", "routine_id"], ["day.id", "day.routine_id"], name="session_day_of_routine", ondelete="RESTRICT"
        ),
        ForeignKeyConstraint(
            ["turn_id", "day_id"], ["turn.id", "turn.day_id"], name="session_turn_of_day", ondelete="SET NULL (turn_id)"
        ),
        Index("session_routine_date", "routine_id", "date"),
        Index("session_turn", "turn_id"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    date: Mapped[dt.date] = mapped_column(Date)
    routine_id: Mapped[int] = mapped_column(ForeignKey("routine.id", ondelete="RESTRICT"))
    day_id: Mapped[int]
    turn_id: Mapped[int | None]
    version: Mapped[int] = mapped_column(server_default="1")
    """Bumped by every write; a write naming an older one is refused (see `wolog.sessions`)."""


def _pins(routine_id: int) -> Select[int | None, dt.date, int]:
    """Every pin of this Routine that still holds a Turn, as (turn_id, date, seq)."""
    skips = select(Skip.turn_id, Skip.date, Skip.id.label("seq")).where(
        Skip.routine_id == routine_id, Skip.turn_id.is_not(None)
    )
    sessions = select(SessionRecord.turn_id, SessionRecord.date, SessionRecord.id.label("seq")).where(
        SessionRecord.routine_id == routine_id, SessionRecord.turn_id.is_not(None)
    )
    return union_all(skips, sessions)  # type: ignore[return-value]


def cursor(db: Session, routine_id: int) -> int | None:
    """The Turn of the latest pin that still holds one, or None."""
    pins = _pins(routine_id).subquery()
    return db.scalar(select(pins.c.turn_id).order_by(pins.c.date.desc(), pins.c.seq.desc()).limit(1))


def next_index(turn_ids: list[int], at: int | None) -> int:
    """Where the suggestion is in the rotation: after the cursor Turn, wrapping; else the first."""
    return (turn_ids.index(at) + 1) % len(turn_ids) if at in turn_ids else 0


def first_turn_of(rotation: list[tuple[int, int]], day_id: int, start: int) -> int | None:
    """The id of the Day's first Turn at or after index `start` of the rotation (Turn id, Day id
    pairs in order), wrapping around; None when the Day has no Turn."""
    for k in range(len(rotation)):
        turn_id, turn_day = rotation[(start + k) % len(rotation)]
        if turn_day == day_id:
            return turn_id
    return None
