"""Pins and the cursor (spec §3 Pins, §4.4 Cursor).

Skips (and, from the Session ticket on, Sessions) pin a Routine, a Day and a Turn. The Turn pin may
dangle: when the Turn is removed, the database sets turn_id to null and the pin holds no Turn.

The cursor of a Routine is the Turn of its latest pin (by date, then order within the date) that
still holds a Turn. Walking back past pins whose Turn is gone is just skipping nulls. Sessions join
as a second branch of `_pins` (§4.4: the latest Session, then later Skips); that gives the same
answer, because a date can't hold both a Session and Skips of one Routine.
"""

import datetime as dt

from sqlalchemy import Date, ForeignKey, ForeignKeyConstraint, Identity, Index, Select, select
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


def _pins(routine_id: int) -> Select[int | None, dt.date, int]:
    """Every pin of this Routine that still holds a Turn, as (turn_id, date, seq)."""
    return select(Skip.turn_id, Skip.date, Skip.id.label("seq")).where(
        Skip.routine_id == routine_id, Skip.turn_id.is_not(None)
    )


def cursor(db: Session, routine_id: int) -> int | None:
    """The Turn of the latest pin that still holds one, or None."""
    pins = _pins(routine_id).subquery()
    return db.scalar(select(pins.c.turn_id).order_by(pins.c.date.desc(), pins.c.seq.desc()).limit(1))


def next_index(turn_ids: list[int], at: int | None) -> int:
    """Where the suggestion is in the rotation: after the cursor Turn, wrapping; else the first."""
    return (turn_ids.index(at) + 1) % len(turn_ids) if at in turn_ids else 0
