"""The Exercise library (spec §4.1): list and create."""

from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import CheckConstraint, Identity, Index, func, select
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


class ExerciseIn(BaseModel):
    name: str


class ExerciseOut(BaseModel):
    id: int
    name: str


router = APIRouter(prefix="/api/exercises", tags=["exercises"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


def _taken(name: str) -> Refusal:
    return Refusal(status.HTTP_409_CONFLICT, "name_taken", f"There is already an Exercise called “{name}”.")


@router.get("")
def list_exercises(db: DbSession) -> list[ExerciseOut]:
    rows = db.scalars(select(Exercise).order_by(func.lower(Exercise.name), Exercise.id))
    return [ExerciseOut(id=e.id, name=e.name) for e in rows]


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": RefusalBody}, 422: {"model": RefusalBody}},
)
def create_exercise(body: ExerciseIn, db: DbSession) -> ExerciseOut:
    name = names.normalise(body.name)
    if not name:
        raise Refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, "name_empty", "An Exercise needs a name.")
    existing = db.scalar(select(Exercise).where(func.lower(Exercise.name) == func.lower(name)))
    if existing is not None:
        raise _taken(existing.name)
    exercise = Exercise(name=name)
    db.add(exercise)
    try:
        db.flush()
    except IntegrityError as exc:  # another request took the name meanwhile
        raise _taken(name) from exc
    return ExerciseOut(id=exercise.id, name=exercise.name)
