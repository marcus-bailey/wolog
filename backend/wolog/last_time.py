"""Last-time and the prefill source (spec §4.8; LOG-7, LOG-2).

Last-time of an Exercise, for a Session being logged on a date, is the latest Session dated strictly
before it that has at least one Set of that Exercise identity, whatever its Routine or Day. Sessions
with no such Set (even with an empty Line of it) are walked past; Skips play no part. It is derived
from current data on every ask, never stored, so it follows the Exercise through rename and Retire and
changes as soon as a past Session is edited or deleted.

The answer is that Session's date and every Set of the Exercise in recorded order, grouped by Line;
the Routine and Day are not shown. The prefill source is its first Working Set, or its first Set when
it has no Working Set. (Prefill from the Line's own previous Set is the screen's, not the API's.)
"""

import datetime as dt
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from wolog import names
from wolog.db import MAX_ID, get_session
from wolog.exercises import Exercise
from wolog.pins import SessionRecord
from wolog.refusals import Refusal, documented
from wolog.sessions import SessionLine, SessionSet, SetOut


class LastTimeLine(BaseModel):
    sets: list[SetOut]


class LastTimeSession(BaseModel):
    """The Session Last-time comes from: its date, and its Sets of the Exercise by Line, in order."""

    date: dt.date
    lines: list[LastTimeLine]


class Prefill(BaseModel):
    reps: int
    weight: str


class LastTimeOut(BaseModel):
    """`exercise_id` is null when a name was asked that no Exercise has; `last_time` and `prefill`
    are null when nothing earlier has a Set of it."""

    exercise_id: int | None
    last_time: LastTimeSession | None
    prefill: Prefill | None


router = APIRouter(tags=["last-time"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


def _exercise(db: Session, exercise_id: int | None, name: str | None) -> Exercise | None:
    if (exercise_id is None) == (name is None):
        raise Refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_request",
            "Name the Exercise once: by exercise_id or by name.",
        )
    if exercise_id is not None:
        found = db.get(Exercise, exercise_id) if 1 <= exercise_id <= MAX_ID else None
        if found is None:
            raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Exercise no longer exists.")
        return found
    assert name is not None
    return db.scalar(select(Exercise).where(func.lower(Exercise.name) == func.lower(names.normalise(name))))


def last_time(db: Session, exercise_id: int, before: dt.date) -> LastTimeSession | None:
    """Walk back from `before` to the latest Session holding a Set of the Exercise."""
    session_id = db.scalar(
        select(SessionRecord.id)
        .join(SessionLine, SessionLine.session_id == SessionRecord.id)
        .join(SessionSet, SessionSet.line_id == SessionLine.id)
        .where(SessionLine.exercise_id == exercise_id, SessionRecord.date < before)
        .order_by(SessionRecord.date.desc())
        .limit(1)
    )
    if session_id is None:
        return None
    record = db.get(SessionRecord, session_id)
    assert record is not None
    lines: dict[int, list[SetOut]] = {}
    for line_id, s in db.execute(
        select(SessionLine.id, SessionSet)
        .join(SessionSet, SessionSet.line_id == SessionLine.id)
        .where(SessionLine.session_id == session_id, SessionLine.exercise_id == exercise_id)
        .order_by(SessionLine.position, SessionSet.position)
    ):
        lines.setdefault(line_id, []).append(
            SetOut(id=s.id, reps=s.reps, weight=str(s.weight), warmup=s.warmup, note=s.note)
        )
    return LastTimeSession(date=record.date, lines=[LastTimeLine(sets=sets) for sets in lines.values()])


def prefill(last: LastTimeSession | None) -> Prefill | None:
    """Last-time's first Working Set, or its first Set when it has no Working Set."""
    sets = [s for line in last.lines for s in line.sets] if last else []
    first = next((s for s in sets if not s.warmup), sets[0] if sets else None)
    return None if first is None else Prefill(reps=first.reps, weight=first.weight)


@router.get("/api/last-time", responses=documented(404, 422))
def get_last_time(
    before: dt.date, db: DbSession, exercise_id: int | None = None, name: str | None = None
) -> LastTimeOut:
    """Last-time of an Exercise for a Session being logged on `before`, and the prefill source. Name
    the Exercise by `exercise_id`, or by `name` as typed on a Line not yet saved (a name no Exercise
    has answers nulls)."""
    exercise = _exercise(db, exercise_id, name)
    if exercise is None:
        return LastTimeOut(exercise_id=None, last_time=None, prefill=None)
    last = last_time(db, exercise.id, before)
    return LastTimeOut(exercise_id=exercise.id, last_time=last, prefill=prefill(last))
