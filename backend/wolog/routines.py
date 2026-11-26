"""Routines (spec §4.2: create, rename) and the Engaged Routine switch (spec §4.7).

Once any Routine exists, exactly one is engaged. The first Routine created is engaged; after
that the engagement changes only by switching to another Routine. There is no disengage, and
switches are not recorded. The database enforces the invariant too (migration 0003).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import CheckConstraint, Identity, Index, false, func, select, text, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from wolog import names
from wolog.db import MAX_ID, Base, get_session
from wolog.refusals import Refusal, documented


class Routine(Base):
    __tablename__ = "routine"
    __table_args__ = (
        CheckConstraint("name <> ''", name="routine_name_not_empty"),
        Index("routine_name_key", func.lower("name"), unique=True),
        Index("routine_one_engaged", "engaged", unique=True, postgresql_where=text("engaged")),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    name: Mapped[str]
    engaged: Mapped[bool] = mapped_column(server_default=false())


class RoutineIn(BaseModel):
    name: str


class RoutineOut(BaseModel):
    id: int
    name: str
    engaged: bool


router = APIRouter(prefix="/api/routines", tags=["routines"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


def _out(r: Routine) -> RoutineOut:
    return RoutineOut(id=r.id, name=r.name, engaged=r.engaged)


def _lock(db: Session) -> None:
    """Every Routine write takes this lock until its transaction ends, so writes run one at a time:
    two first Routines can't both be engaged, two switches can't cross, and a name checked free stays
    free until it is written. Reads are not blocked."""
    db.execute(text("lock table routine in exclusive mode"))


def _valid_name(db: Session, raw: str, routine: Routine | None) -> str:
    """The normalised name, refused if empty or held by another Routine."""
    name = names.normalise(raw)
    if not name:
        raise Refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, "name_empty", "A Routine needs a name.")
    other = db.scalar(select(Routine).where(func.lower(Routine.name) == func.lower(name)))
    if other is not None and other is not routine:
        raise Refusal(status.HTTP_409_CONFLICT, "name_taken", f"There is already a Routine called “{other.name}”.")
    return name


def _get(db: Session, routine_id: int) -> Routine:
    # An id beyond the column's range names no Routine; asking Postgres would fail, not miss.
    routine = db.get(Routine, routine_id) if 1 <= routine_id <= MAX_ID else None
    if routine is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Routine no longer exists.")
    return routine


@router.get("")
def list_routines(db: DbSession) -> list[RoutineOut]:
    """Every Routine by name; the Engaged Routine is the one with `engaged` true. Empty means first run."""
    return [_out(r) for r in db.scalars(select(Routine).order_by(func.lower(Routine.name), Routine.id))]


@router.post("", status_code=status.HTTP_201_CREATED, responses=documented(409, 422))
def create_routine(body: RoutineIn, db: DbSession) -> RoutineOut:
    """A Routine with a name only: no Days and an empty rotation. The first one is engaged; later ones are not."""
    _lock(db)
    first = db.scalar(select(Routine.id).limit(1)) is None
    routine = Routine(name=_valid_name(db, body.name, None), engaged=first)
    db.add(routine)
    db.flush()
    return _out(routine)


@router.patch("/{routine_id}", responses=documented(404, 409, 422))
def rename_routine(routine_id: int, body: RoutineIn, db: DbSession) -> RoutineOut:
    """Rename is a label change. A name held by another Routine is refused."""
    _lock(db)
    routine = _get(db, routine_id)
    routine.name = _valid_name(db, body.name, routine)
    db.flush()
    return _out(routine)


@router.post("/{routine_id}/engage", responses=documented(404, 422))
def engage_routine(routine_id: int, db: DbSession) -> RoutineOut:
    """Switch the Engaged Routine to this one. Engaging the Engaged Routine changes nothing.
    Only where new work goes changes; existing Sessions and Skips are untouched."""
    _lock(db)
    routine = _get(db, routine_id)
    if not routine.engaged:
        # Clear first, then set: the unique index allows one engaged row at any moment.
        db.execute(update(Routine).where(Routine.engaged).values(engaged=False))
        db.execute(update(Routine).where(Routine.id == routine.id).values(engaged=True))
        db.refresh(routine)
    return _out(routine)
