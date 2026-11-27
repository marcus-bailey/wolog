"""Up next, Skip and Undo last Skip (spec §4.4, §4.7; TDY-1, TDY-3, TDY-5).

The suggestion is derived on demand per Routine and never stored: the Turn after the cursor (see
`wolog.pins`) in the current order, wrapping; with no cursor, the first Turn; with an empty rotation,
none.

Dates are civil dates from the browser (§7). The client sends its `today`; the API accepts it when it
is within a day of the server's UTC date, which covers every time zone.
"""

import datetime as dt
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from wolog.days import Day, Turn
from wolog.db import MAX_ID, get_session
from wolog.pins import SessionRecord, Skip, cursor, next_index
from wolog.refusals import Refusal, documented
from wolog.routines import Routine, RoutineOut


class SuggestionOut(BaseModel):
    """The suggested Turn: `position` of `of` in the rotation (1-based), naming its Day."""

    turn_id: int
    day_id: int
    day_name: str
    position: int
    of: int


class SkipOut(BaseModel):
    id: int
    date: dt.date
    day_id: int
    day_name: str


class UpNext(BaseModel):
    """What Today shows before a Session. `routine` is null when no Routine exists (first run);
    `suggestion` is null when the rotation is empty; `last_skip` is what Undo last Skip would remove."""

    routine: RoutineOut | None
    suggestion: SuggestionOut | None
    last_skip: SkipOut | None


class SkipIn(BaseModel):
    """Skip the suggestion the owner saw: on `routine_id`, `turn_id`. `today` is the browser's date."""

    routine_id: int
    turn_id: int
    date: dt.date
    today: dt.date


router = APIRouter(tags=["today"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]


def suggestion(db: Session, routine: Routine) -> SuggestionOut | None:
    rows = db.execute(
        select(Turn, Day.name)
        .join(Day, Day.id == Turn.day_id)
        .where(Turn.routine_id == routine.id)
        .order_by(Turn.position)
    ).all()
    if not rows:
        return None
    index = next_index([turn.id for turn, _ in rows], cursor(db, routine.id))
    turn, day_name = rows[index]
    return SuggestionOut(turn_id=turn.id, day_id=turn.day_id, day_name=day_name, position=index + 1, of=len(rows))


def _last_skip(db: Session, routine: Routine) -> Skip | None:
    return db.scalar(
        select(Skip).where(Skip.routine_id == routine.id).order_by(Skip.date.desc(), Skip.id.desc()).limit(1)
    )


def latest_session_date(db: Session, routine: Routine) -> dt.date | None:
    return db.scalar(
        select(SessionRecord.date)
        .where(SessionRecord.routine_id == routine.id)
        .order_by(SessionRecord.date.desc())
        .limit(1)
    )


def _engaged(db: Session, *, lock: bool = False) -> Routine | None:
    """The Engaged Routine. Locked, it can't be switched away from, nor its rotation changed, until commit."""
    query = select(Routine).where(Routine.engaged)
    return db.scalar(query.with_for_update() if lock else query)


def _up_next(db: Session, routine: Routine | None) -> UpNext:
    if routine is None:
        return UpNext(routine=None, suggestion=None, last_skip=None)
    last = _last_skip(db, routine)
    last_out = None
    if last is not None:
        day = db.get(Day, last.day_id)
        assert day is not None  # a Skip's Day can't be destroyed while the Skip pins it
        last_out = SkipOut(id=last.id, date=last.date, day_id=day.id, day_name=day.name)
    return UpNext(
        routine=RoutineOut(id=routine.id, name=routine.name, engaged=routine.engaged),
        suggestion=suggestion(db, routine),
        last_skip=last_out,
    )


def check_today(today: dt.date) -> None:
    server = dt.datetime.now(dt.UTC).date()
    if abs((today - server).days) > 1:
        raise Refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "today_implausible",
            f"Your device says today is {shown(today)}, which can’t be right. Check its date and try again.",
        )


def shown(date: dt.date) -> str:
    return f"{date.day} {date:%b %Y}"


def engaged_as_seen(db: Session, routine_id: int) -> Routine:
    """The Engaged Routine, locked, refused if it isn't the one the owner was looking at."""
    routine = _engaged(db, lock=True)
    if routine is None:
        raise Refusal(status.HTTP_409_CONFLICT, "no_routine", "There is no Routine yet. Create one first.")
    if routine.id != routine_id:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "routine_switched",
            f"The Engaged Routine is now “{routine.name}”. Up next has changed; check it and try again.",
        )
    return routine


@router.get("/api/up-next")
def up_next(db: DbSession) -> UpNext:
    """The Engaged Routine, its suggested Turn, and its last Skip."""
    return _up_next(db, _engaged(db))


@router.post("/api/skips", status_code=status.HTTP_201_CREATED, responses=documented(409, 422))
def skip(body: SkipIn, db: DbSession) -> UpNext:
    """Pass the suggested Turn of the Engaged Routine on a date. Several Skips may share a date. The
    date may not be in the future, and must be on or after this Routine's latest Skip date."""
    check_today(body.today)
    routine = engaged_as_seen(db, body.routine_id)
    suggested = suggestion(db, routine)
    if suggested is None:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "rotation_empty",
            f"Nothing is on the rotation of “{routine.name}”, so there is nothing to Skip.",
        )
    if suggested.turn_id != body.turn_id:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "suggestion_changed",
            f"Up next is now {suggested.day_name}. Check it and try again.",
        )
    if body.date > body.today:
        raise Refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, "date_in_future", "A Skip can’t be dated in the future.")
    last = _last_skip(db, routine)
    if last is not None and body.date < last.date:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "date_before_last_skip",
            f"A Skip must be dated on or after {shown(last.date)}, the date of this Routine’s last Skip.",
        )
    latest_session = latest_session_date(db, routine)
    if latest_session is not None and body.date == latest_session:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "date_has_session",
            f"{shown(body.date)} holds a Session of this Routine, so it can’t also hold a Skip.",
        )
    if latest_session is not None and body.date < latest_session:
        # Skips pass the live suggestion, so one dated before the latest Session would pass nothing.
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "date_before_last_session",
            f"A Skip must be dated after {shown(latest_session)}, the date of this Routine’s latest Session.",
        )
    db.add(Skip(date=body.date, routine_id=routine.id, day_id=suggested.day_id, turn_id=suggested.turn_id))
    db.flush()
    return _up_next(db, routine)


@router.delete("/api/skips/{skip_id}", responses=documented(404, 409, 422))
def undo_skip(skip_id: int, db: DbSession) -> UpNext:
    """Undo last Skip: remove the most recent Skip of the Engaged Routine. No other Skip can be removed."""
    found = db.get(Skip, skip_id) if 1 <= skip_id <= MAX_ID else None
    if found is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Skip no longer exists.")
    routine = _engaged(db, lock=True)
    last = _last_skip(db, routine) if routine is not None else None
    if last is None or last.id != found.id:
        raise Refusal(
            status.HTTP_409_CONFLICT, "not_last_skip", "Only the last Skip of the Engaged Routine can be undone."
        )
    db.delete(found)
    db.flush()
    return _up_next(db, routine)
