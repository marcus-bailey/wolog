"""Days and their Lines (spec §4.3, DAY-1 create / rename, DAY-2), and the Routine detail they live in.

A Day belongs to one Routine for good, with a name unique within it. A new Day gets one Turn at the
end of its Routine's rotation. A Day's Lines are ordered; the same Exercise may be on several, and
a Line stays when its Exercise is Retired later. Lines are added by typing a name (spec §4.1).
"""

from collections.abc import Sequence
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    UniqueConstraint,
    delete,
    func,
    select,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from wolog import exercises, names
from wolog.db import MAX_ID, Base, get_session
from wolog.exercises import Exercise, ExerciseOut
from wolog.pins import cursor, next_index
from wolog.refusals import Refusal, documented
from wolog.routines import Routine, RoutineOut


class Day(Base):
    __tablename__ = "day"
    __table_args__ = (
        CheckConstraint("name <> ''", name="day_name_not_empty"),
        UniqueConstraint("id", "routine_id", name="day_id_routine_key"),
        Index("day_name_key", "routine_id", func.lower("name"), unique=True),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    routine_id: Mapped[int] = mapped_column(ForeignKey("routine.id", ondelete="CASCADE"))
    name: Mapped[str]


class DayLine(Base):
    __tablename__ = "day_line"
    __table_args__ = (
        CheckConstraint("position >= 0", name="day_line_position_not_negative"),
        UniqueConstraint("day_id", "position", name="day_line_position_key", deferrable=True, initially="DEFERRED"),
        Index("day_line_exercise", "exercise_id"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    day_id: Mapped[int] = mapped_column(ForeignKey("day.id", ondelete="CASCADE"))
    exercise_id: Mapped[int] = mapped_column(ForeignKey("exercise.id", ondelete="RESTRICT"))
    position: Mapped[int]


class Turn(Base):
    """One place in a Routine's rotation, naming a Day of that Routine (the composite key enforces it)."""

    __tablename__ = "turn"
    __table_args__ = (
        CheckConstraint("position >= 0", name="turn_position_not_negative"),
        ForeignKeyConstraint(
            ["day_id", "routine_id"], ["day.id", "day.routine_id"], name="turn_day_of_routine", ondelete="CASCADE"
        ),
        UniqueConstraint("routine_id", "position", name="turn_position_key", deferrable=True, initially="DEFERRED"),
        UniqueConstraint("id", "day_id", name="turn_id_day_key"),
        Index("turn_day", "day_id"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    routine_id: Mapped[int] = mapped_column(ForeignKey("routine.id", ondelete="CASCADE"))
    day_id: Mapped[int]
    position: Mapped[int]


class DayIn(BaseModel):
    name: str


class LineIn(BaseModel):
    """The Exercise's name as typed: a live Exercise's name attaches it; a new name creates it."""

    name: str


class LineOrder(BaseModel):
    """Every Line of the Day, by id, in the new order."""

    line_ids: list[int]


class LineOut(BaseModel):
    id: int
    exercise: ExerciseOut


class DayOut(BaseModel):
    id: int
    name: str
    lines: list[LineOut]


class TurnOut(BaseModel):
    id: int
    day_id: int


class RoutineDetail(RoutineOut):
    """A Routine with its Days (in the order they were created) and its rotation (Turns in order)."""

    days: list[DayOut]
    rotation: list[TurnOut]
    next_turn_id: int | None
    """The Turn the suggestion would be on (spec §4.4), whether or not this Routine is engaged."""


router = APIRouter(tags=["days"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


def _day_out(db: Session, day: Day) -> DayOut:
    rows = db.execute(
        select(DayLine, Exercise)
        .join(Exercise, Exercise.id == DayLine.exercise_id)
        .where(DayLine.day_id == day.id)
        .order_by(DayLine.position)
    )
    return DayOut(
        id=day.id, name=day.name, lines=[LineOut(id=line.id, exercise=exercises.exercise_out(e)) for line, e in rows]
    )


def get_routine(db: Session, routine_id: int, *, lock: bool = False) -> Routine:
    """The Routine. Lock it to change its Days' names or its rotation: those writes run one at a time."""
    routine = db.get(Routine, routine_id, with_for_update=lock) if 1 <= routine_id <= MAX_ID else None
    if routine is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Routine no longer exists.")
    return routine


def _get_day(db: Session, day_id: int) -> Day:
    """The Day, locked FOR UPDATE: its Lines change one request at a time."""
    day = db.get(Day, day_id, with_for_update=True) if 1 <= day_id <= MAX_ID else None
    if day is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Day no longer exists.")
    return day


def _valid_name(db: Session, raw: str, routine_id: int, day: Day | None) -> str:
    """The normalised name, refused if empty or held by another Day of the Routine. The caller holds
    the Routine's lock, so the name stays free until it is written."""
    name = names.normalise(raw)
    if not name:
        raise Refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, "name_empty", "A Day needs a name.")
    other = db.scalar(select(Day).where(Day.routine_id == routine_id, func.lower(Day.name) == func.lower(name)))
    if other is not None and other is not day:
        raise Refusal(
            status.HTTP_409_CONFLICT, "name_taken", f"There is already a Day called “{other.name}” in this Routine."
        )
    return name


def renumber(items: Sequence[DayLine | Turn]) -> None:
    """Number Lines or Turns 0, 1, 2… in this order."""
    for position, item in enumerate(items):
        item.position = position


def append_turn(db: Session, routine: Routine, day_id: int) -> None:
    """One more Turn for the Day, at the end of the rotation. The caller holds the Routine's lock."""
    end = db.scalar(select(func.count()).select_from(Turn).where(Turn.routine_id == routine.id)) or 0
    db.add(Turn(routine_id=routine.id, day_id=day_id, position=end))
    db.flush()


def detail_of(db: Session, routine: Routine) -> RoutineDetail:
    days = db.scalars(select(Day).where(Day.routine_id == routine.id).order_by(Day.id))
    turns = list(db.scalars(select(Turn).where(Turn.routine_id == routine.id).order_by(Turn.position)))
    ids = [t.id for t in turns]
    return RoutineDetail(
        id=routine.id,
        name=routine.name,
        engaged=routine.engaged,
        days=[_day_out(db, d) for d in days],
        rotation=[TurnOut(id=t.id, day_id=t.day_id) for t in turns],
        next_turn_id=ids[next_index(ids, cursor(db, routine.id))] if ids else None,
    )


def _lines(db: Session, day: Day) -> list[DayLine]:
    return list(db.scalars(select(DayLine).where(DayLine.day_id == day.id).order_by(DayLine.position)))


@router.get("/api/routines/{routine_id}", responses=documented(404, 422))
def routine_detail(routine_id: int, db: DbSession) -> RoutineDetail:
    return detail_of(db, get_routine(db, routine_id))


@router.get("/api/days/{day_id}", responses=documented(404, 422))
def day_detail(day_id: int, db: DbSession) -> DayOut:
    """The Day with its Lines in order."""
    day = db.get(Day, day_id) if 1 <= day_id <= MAX_ID else None
    if day is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Day no longer exists.")
    return _day_out(db, day)


@router.post(
    "/api/routines/{routine_id}/days", status_code=status.HTTP_201_CREATED, responses=documented(404, 409, 422)
)
def create_day(routine_id: int, body: DayIn, db: DbSession) -> DayOut:
    """A Day with a name and no Lines, and one Turn at the end of the rotation."""
    routine = get_routine(db, routine_id, lock=True)
    day = Day(routine_id=routine.id, name=_valid_name(db, body.name, routine.id, None))
    db.add(day)
    db.flush()
    append_turn(db, routine, day.id)
    return _day_out(db, day)


@router.patch("/api/days/{day_id}", responses=documented(404, 409, 422))
def rename_day(day_id: int, body: DayIn, db: DbSession) -> DayOut:
    """Rename is a label change. A name held by another Day of the same Routine is refused."""
    day = _get_day(db, day_id)
    get_routine(db, day.routine_id, lock=True)
    day.name = _valid_name(db, body.name, day.routine_id, day)
    db.flush()
    return _day_out(db, day)


@router.post("/api/days/{day_id}/lines", status_code=status.HTTP_201_CREATED, responses=documented(404, 409, 422))
def add_line(day_id: int, body: LineIn, db: DbSession) -> DayOut:
    """Add a Line at the end: a live Exercise's name attaches it, a new name creates it, and a Retired
    Exercise's name is refused with a pointer to it. The same Exercise may already be on the Day."""
    day = _get_day(db, day_id)
    exercise = exercises.attach_by_name(db, body.name)
    db.add(DayLine(day_id=day.id, exercise_id=exercise.id, position=len(_lines(db, day))))
    db.flush()
    return _day_out(db, day)


@router.put("/api/days/{day_id}/lines", responses=documented(404, 409, 422))
def reorder_lines(day_id: int, body: LineOrder, db: DbSession) -> DayOut:
    """Put the Day's Lines in this order. It must name every Line exactly once."""
    day = _get_day(db, day_id)
    lines = {line.id: line for line in _lines(db, day)}
    if sorted(body.line_ids) != sorted(lines):
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "lines_changed",
            "The Day’s Lines changed since you loaded them. Reload and try again.",
        )
    renumber([lines[i] for i in body.line_ids])
    db.flush()
    return _day_out(db, day)


@router.delete("/api/days/{day_id}/lines/{line_id}", responses=documented(404, 422))
def remove_line(day_id: int, line_id: int, db: DbSession) -> DayOut:
    """Remove a Line from the Day. Its Exercise stays in the library; past Sessions are unchanged."""
    day = _get_day(db, day_id)
    lines = _lines(db, day)
    if not any(line.id == line_id for line in lines):
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Line is no longer on the Day.")
    db.execute(delete(DayLine).where(DayLine.id == line_id))
    renumber([line for line in lines if line.id != line_id])
    db.flush()
    return _day_out(db, day)
