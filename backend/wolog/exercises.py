"""The Exercise library (spec §4.1): list, create, rename, Retire / Un-retire, and delete if unused."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import CheckConstraint, Identity, Index, false, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from wolog import names
from wolog.db import Base, get_session
from wolog.refusals import Refusal, RefusalBody


class Exercise(Base):
    __tablename__ = "exercise"
    __table_args__ = (
        CheckConstraint("name <> ''", name="exercise_name_not_empty"),
        Index("exercise_name_key", func.lower("name"), unique=True),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    name: Mapped[str]
    retired: Mapped[bool] = mapped_column(server_default=false())


class ExerciseIn(BaseModel):
    name: str


class ExerciseChange(BaseModel):
    """Rename, Retire or Un-retire. Fields left out stay as they are."""

    name: str | None = None
    retired: bool | None = None


class ExerciseOut(BaseModel):
    id: int
    name: str
    retired: bool


router = APIRouter(prefix="/api/exercises", tags=["exercises"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


def _refusals(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The refusals a route can answer with, for the OpenAPI schema. Every one has the RefusalBody shape."""
    return {s: {"model": RefusalBody} for s in statuses}


def _out(e: Exercise) -> ExerciseOut:
    return ExerciseOut(id=e.id, name=e.name, retired=e.retired)


def _taken(name: str, *, retired: bool, creating: bool) -> Refusal:
    """The refusal for a name another Exercise holds. Typing a Retired Exercise's name to create one
    points to that Exercise and to Un-retire (spec §4.1). A rename has no such way out: the name
    stays taken after Un-retire, so it only says the name is taken."""
    if retired and creating:
        return Refusal(
            status.HTTP_409_CONFLICT, "name_retired", f"“{name}” is a Retired Exercise. Un-retire it to use it again."
        )
    holder = "a Retired Exercise" if retired else "an Exercise"
    return Refusal(status.HTTP_409_CONFLICT, "name_taken", f"There is already {holder} called “{name}”.")


def _valid_name(raw: str) -> str:
    name = names.normalise(raw)
    if not name:
        raise Refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, "name_empty", "An Exercise needs a name.")
    return name


def _named(db: Session, name: str) -> Exercise | None:
    return db.scalar(select(Exercise).where(func.lower(Exercise.name) == func.lower(name)))


def _claim_name(db: Session, exercise: Exercise, name: str, *, creating: bool) -> None:
    """Give the Exercise this name, or refuse if another Exercise holds it. The unique index settles
    a race with a request that took the name after the check; the refusal then names that Exercise too."""
    other = _named(db, name)
    if other is not None and other is not exercise:
        raise _taken(other.name, retired=other.retired, creating=creating)
    try:
        # Change the Exercise only inside the savepoint: a failed flush then rolls back just the
        # savepoint, and the transaction stays usable to look up who holds the name.
        with db.begin_nested():
            exercise.name = name
            db.add(exercise)
            db.flush()
    except IntegrityError as exc:
        other = _named(db, name)
        if other is None:  # it was taken and freed again meanwhile
            raise _taken(name, retired=False, creating=creating) from exc
        raise _taken(other.name, retired=other.retired, creating=creating) from exc


def _get_locked(db: Session, exercise_id: int) -> Exercise:
    """The Exercise, locked FOR UPDATE until the request's transaction ends."""
    exercise = db.get(Exercise, exercise_id, with_for_update=True)
    if exercise is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Exercise no longer exists.")
    return exercise


@router.get("", responses=_refusals(422))
def list_exercises(db: DbSession, retired: bool | None = None) -> list[ExerciseOut]:
    """Every Exercise, or with `retired=false` only those a picker offers, or with `retired=true` only Retired ones."""
    query = select(Exercise).order_by(func.lower(Exercise.name), Exercise.id)
    if retired is not None:
        query = query.where(Exercise.retired == retired)
    return [_out(e) for e in db.scalars(query)]


@router.post("", status_code=status.HTTP_201_CREATED, responses=_refusals(409, 422))
def create_exercise(body: ExerciseIn, db: DbSession) -> ExerciseOut:
    exercise = Exercise()
    _claim_name(db, exercise, _valid_name(body.name), creating=True)
    return _out(exercise)


@router.patch("/{exercise_id}", responses=_refusals(404, 409, 422))
def change_exercise(exercise_id: int, body: ExerciseChange, db: DbSession) -> ExerciseOut:
    """Rename keeps the identity; a name held by another Exercise, live or Retired, is refused (no merge)."""
    exercise = _get_locked(db, exercise_id)
    if body.name is not None:
        _claim_name(db, exercise, _valid_name(body.name), creating=False)
    if body.retired is not None:
        exercise.retired = body.retired
    db.flush()
    return _out(exercise)


@router.delete("/{exercise_id}", status_code=status.HTTP_204_NO_CONTENT, responses=_refusals(404, 409, 422))
def delete_exercise(exercise_id: int, db: DbSession) -> None:
    """Hard-delete an unused Exercise. Every Line references its Exercise with ON DELETE RESTRICT,
    so an Exercise on any Line (Day or Session, empty or not) cannot be deleted; Retire it instead."""
    exercise = _get_locked(db, exercise_id)
    name = exercise.name
    try:
        with db.begin_nested():
            db.delete(exercise)
            db.flush()
    except IntegrityError as exc:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "exercise_in_use",
            f"“{name}” is on a Line, so it can’t be deleted. Retire it to hide it from pickers instead.",
        ) from exc
