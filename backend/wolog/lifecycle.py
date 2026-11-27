"""Duplicate and Destroy for Routines and Days (spec §4.2, §4.3; RTN-3, RTN-4, DAY-1 destroy, DAY-4).

A copy is new rows with the same Exercises, and keeps no link back: nothing records where it came
from. Sessions and Skips are never copied.

Sessions and Skips pin their Routine and Day for good, so destroying either is refused while any
of them points at it; they are never cascaded (the database restricts it too). What does go with a
destroyed Day is its Turns and Lines, and with a destroyed Routine its Days. Exercises always stay.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import ColumnElement, delete, func, select
from sqlalchemy.orm import Session

from wolog.days import (
    Day,
    DayLine,
    RoutineDetail,
    Turn,
    append_turn,
    detail_of,
    get_routine,
    lock_day,
    renumber,
    valid_day_name,
)
from wolog.db import MAX_ID, get_session
from wolog.pins import SessionRecord, Skip
from wolog.refusals import Refusal, documented
from wolog.routines import Routine, RoutineIn, lock_routines, valid_name

router = APIRouter(tags=["lifecycle"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


class DayCopyIn(BaseModel):
    """Where the copy goes (this Day's Routine or another) and its name there."""

    routine_id: int
    name: str


def _copy_day(db: Session, source: Day, routine_id: int, name: str) -> Day:
    """A new Day in the Routine with new Lines on the same Exercises, in order. No Turn.

    A Line of a Retired Exercise is copied too: the copy has the same Exercises (spec §4.3), and such
    a Line stays on its Day. Only a Line added by name can't pick a Retired Exercise."""
    copy = Day(routine_id=routine_id, name=name)
    db.add(copy)
    db.flush()
    lines = db.scalars(select(DayLine).where(DayLine.day_id == source.id).order_by(DayLine.position))
    db.add_all(DayLine(day_id=copy.id, exercise_id=line.exercise_id, position=i) for i, line in enumerate(lines))
    db.flush()
    return copy


def _pins(db: Session, session_pin: ColumnElement[bool], skip_pin: ColumnElement[bool]) -> str | None:
    """What pins it, as "2 Sessions and 1 Skip point" or "1 Skip points"; None when nothing does."""
    sessions = db.scalar(select(func.count()).select_from(SessionRecord).where(session_pin)) or 0
    skips = db.scalar(select(func.count()).select_from(Skip).where(skip_pin)) or 0
    parts = [f"{n} {kind}{'' if n == 1 else 's'}" for n, kind in ((sessions, "Session"), (skips, "Skip")) if n]
    if not parts:
        return None
    return f"{' and '.join(parts)} {'points' if sessions + skips == 1 else 'point'}"


@router.post(
    "/api/routines/{routine_id}/duplicate", status_code=status.HTTP_201_CREATED, responses=documented(404, 409, 422)
)
def duplicate_routine(routine_id: int, body: RoutineIn, db: DbSession) -> RoutineDetail:
    """A new Routine under a new unique name, with a copy of every Day and its Lines, and the Turns in
    order. No Sessions or Skips, so its suggestion is its first Turn. It is not engaged."""
    lock_routines(db)  # the name stays free, and no rotation changes meanwhile
    source = get_routine(db, routine_id)
    copy = Routine(name=valid_name(db, body.name, None), engaged=False)
    db.add(copy)
    db.flush()
    days = {
        day.id: _copy_day(db, day, copy.id, day.name).id
        for day in db.scalars(select(Day).where(Day.routine_id == source.id).order_by(Day.id)).all()
    }
    turns = db.scalars(select(Turn).where(Turn.routine_id == source.id).order_by(Turn.position)).all()
    db.add_all(Turn(routine_id=copy.id, day_id=days[t.day_id], position=i) for i, t in enumerate(turns))
    db.flush()
    return detail_of(db, copy)


@router.post("/api/days/{day_id}/duplicate", status_code=status.HTTP_201_CREATED, responses=documented(404, 409, 422))
def duplicate_day(day_id: int, body: DayCopyIn, db: DbSession) -> RoutineDetail:
    """Copy the Day into this Routine or another, under a name unique there, with one Turn at the end
    of that rotation. Answers with the target Routine."""
    target = get_routine(db, body.routine_id, lock=True)  # Routine first, then the Day, as Session writes do
    source = db.get(Day, day_id, with_for_update={"read": True}) if 1 <= day_id <= MAX_ID else None
    if source is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Day no longer exists.")
    name = valid_day_name(db, body.name, target.id, None, where=f"“{target.name}”")
    copy = _copy_day(db, source, target.id, name)
    append_turn(db, target, copy.id)
    return detail_of(db, target)


@router.delete("/api/days/{day_id}", responses=documented(404, 409, 422))
def destroy_day(day_id: int, db: DbSession) -> RoutineDetail:
    """Destroy a Day nothing pins, with its Turns and Lines. Its Exercises stay in the library. A
    pinned Day is refused, and the refusal offers Drop. Answers with its Routine."""
    routine, day = lock_day(db, day_id)  # Session writes and Change-Day wait, so no new pin lands meanwhile
    pins = _pins(db, SessionRecord.day_id == day.id, Skip.day_id == day.id)
    if pins is not None:
        on_rotation = db.scalar(select(Turn.id).where(Turn.day_id == day.id).limit(1)) is not None
        instead = (
            "Drop it from the rotation instead; it stays in the Routine with its Lines."
            if on_rotation
            else "It is off the rotation already, and can stay there."
        )
        raise Refusal(
            status.HTTP_409_CONFLICT, "day_pinned", f"“{day.name}” can’t be destroyed: {pins} at it. {instead}"
        )
    db.execute(delete(Day).where(Day.id == day.id))  # its Turns and Lines go with it
    db.expunge(day)
    renumber(db.scalars(select(Turn).where(Turn.routine_id == routine.id).order_by(Turn.position)).all())
    db.flush()
    return detail_of(db, routine)


@router.delete(
    "/api/routines/{routine_id}", status_code=status.HTTP_204_NO_CONTENT, responses=documented(404, 409, 422)
)
def destroy_routine(routine_id: int, db: DbSession) -> None:
    """Destroy a Routine nothing pins, with its Days. The Engaged Routine can go only when it is the
    only one, which returns the app to first run."""
    lock_routines(db)  # no switch, and no Session or Skip write (they lock the Engaged Routine), meanwhile
    routine = get_routine(db, routine_id)
    pins = _pins(db, SessionRecord.routine_id == routine.id, Skip.routine_id == routine.id)
    if pins is not None:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "routine_pinned",
            f"“{routine.name}” can’t be destroyed: {pins} at it or its Days.",
        )
    if routine.engaged and db.scalar(select(Routine.id).where(Routine.id != routine.id).limit(1)) is not None:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "routine_engaged",
            f"“{routine.name}” is the Engaged Routine. Switch to another Routine first, then destroy it.",
        )
    db.execute(delete(Routine).where(Routine.id == routine.id))  # its Days, Turns and Lines go with it
    db.expunge(routine)
