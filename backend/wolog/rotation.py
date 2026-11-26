"""Shaping the rotation (spec §4.3 Rotation, DAY-3).

The rotation is an ordered list of Turns, each naming a Day of the Routine; a Day may have several.
A Day is on the rotation while it has at least one Turn. Additions go to the end. Reordering keeps
each Turn's identity, and old positions are not remembered. Removing a Turn is always allowed, and
the rotation may be empty. Drop removes all of a Day's Turns; Put back adds one at the end.

Every write locks the Routine, so rotation changes run one at a time, and answers with the whole
Routine detail.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from wolog.days import Day, RoutineDetail, Turn, append_turn, detail_of, get_routine, renumber
from wolog.db import MAX_ID, get_session
from wolog.refusals import Refusal, documented
from wolog.routines import Routine

router = APIRouter(tags=["rotation"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


class TurnIn(BaseModel):
    """The Day the new Turn names."""

    day_id: int


class TurnOrder(BaseModel):
    """Every Turn of the rotation, by id, in the new order."""

    turn_ids: list[int]


def _turns(db: Session, routine: Routine) -> list[Turn]:
    return list(db.scalars(select(Turn).where(Turn.routine_id == routine.id).order_by(Turn.position)))


def _day_of(db: Session, routine: Routine, day_id: int) -> Day:
    day = db.get(Day, day_id) if 1 <= day_id <= MAX_ID else None
    if day is None or day.routine_id != routine.id:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Day is not in this Routine.")
    return day


def _routine_of_day(db: Session, day_id: int) -> tuple[Routine, Day]:
    """The Day and its Routine, the Routine locked."""
    day = db.get(Day, day_id) if 1 <= day_id <= MAX_ID else None
    if day is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Day no longer exists.")
    return get_routine(db, day.routine_id, lock=True), day


@router.post("/api/routines/{routine_id}/turns", responses=documented(404, 422))
def add_turn(routine_id: int, body: TurnIn, db: DbSession) -> RoutineDetail:
    """Add a Turn for a Day of this Routine at the end of the rotation. A Day may have several."""
    routine = get_routine(db, routine_id, lock=True)
    append_turn(db, routine, _day_of(db, routine, body.day_id).id)
    return detail_of(db, routine)


@router.put("/api/routines/{routine_id}/turns", responses=documented(404, 409, 422))
def reorder_turns(routine_id: int, body: TurnOrder, db: DbSession) -> RoutineDetail:
    """Put the rotation's Turns in this order. It must name every Turn exactly once."""
    routine = get_routine(db, routine_id, lock=True)
    turns = {t.id: t for t in _turns(db, routine)}
    if sorted(body.turn_ids) != sorted(turns):
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "rotation_changed",
            "The rotation changed since you loaded it. Reload and try again.",
        )
    renumber([turns[i] for i in body.turn_ids])
    db.flush()
    return detail_of(db, routine)


@router.delete("/api/routines/{routine_id}/turns/{turn_id}", responses=documented(404, 422))
def remove_turn(routine_id: int, turn_id: int, db: DbSession) -> RoutineDetail:
    """Remove one Turn. Always allowed; the rotation may become empty. Its Day stays."""
    routine = get_routine(db, routine_id, lock=True)
    turns = _turns(db, routine)
    if not any(t.id == turn_id for t in turns):
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Turn is no longer on the rotation.")
    db.execute(delete(Turn).where(Turn.id == turn_id))
    renumber([t for t in turns if t.id != turn_id])
    db.flush()
    return detail_of(db, routine)


@router.post("/api/days/{day_id}/drop", responses=documented(404, 422))
def drop_day(day_id: int, db: DbSession) -> RoutineDetail:
    """Remove all of the Day's Turns: it is off the rotation, and stays in the Routine with its Lines.
    Dropping a Day already off the rotation changes nothing."""
    routine, day = _routine_of_day(db, day_id)
    turns = _turns(db, routine)
    db.execute(delete(Turn).where(Turn.day_id == day.id))
    renumber([t for t in turns if t.day_id != day.id])
    db.flush()
    return detail_of(db, routine)


@router.post("/api/days/{day_id}/put-back", responses=documented(404, 409, 422))
def put_back_day(day_id: int, db: DbSession) -> RoutineDetail:
    """Put a Day that is off the rotation back on it, with one Turn at the end."""
    routine, day = _routine_of_day(db, day_id)
    if any(t.day_id == day.id for t in _turns(db, routine)):
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "day_on_rotation",
            f"“{day.name}” is already on the rotation. Add a Turn for it to repeat it.",
        )
    append_turn(db, routine, day.id)
    return detail_of(db, routine)
