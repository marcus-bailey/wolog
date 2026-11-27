"""Sessions, their Lines and Sets (spec §3, §4.5, §4.6; LOG-1, LOG-2, LOG-8).

A Session exists from the first saved write that contains a Set: there is no draft and no start.
That write pins the date (the logger's civil date, never in the future), the Engaged Routine (refused
if it changed since the logger opened), and the suggested Turn with its Day. It copies the Day's
Lines (the Snapshot), applies the screen's omissions, reorders and extra Lines, then the Sets. After
that the Session has one list of Lines: later Day edits never change it, and Session writes never
touch the Day. Creating a Session on a date holding this Routine's Skips replaces those Skips; the
Session pins the suggestion as it stood before. At most one Session per date across all Routines.

**Writes are post-state.** The client sends the resulting Lines and Sets and the API validates the
whole; an illegal result is refused with nothing applied. A result with no Set erases the Session.
Every write names the version it was made from, so a screen that missed another write is refused
rather than dropping what it didn't see.

Always editable, whatever the Engaged Routine (spec §4.5): Sets are added (appended), edited,
deleted and reordered within their Line, never moved across Lines; Lines are added by typing a name
(attach or create, as on a Day; Retired refused; repeats allowed) and append; a Line is removed only
while it has no Sets.
"""

import datetime as dt
import re
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import CheckConstraint, ForeignKey, Identity, Index, Numeric, UniqueConstraint, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from wolog import exercises
from wolog.days import Day, DayLine
from wolog.db import MAX_ID, Base, get_session
from wolog.exercises import Exercise, ExerciseOut
from wolog.pins import SessionRecord, Skip
from wolog.refusals import Refusal, documented
from wolog.routines import Routine
from wolog.today import check_today, engaged_as_seen, shown, suggestion


class SessionLine(Base):
    """An ordered appearance of an Exercise on a Session: the Session's own, not linked to a Day Line."""

    __tablename__ = "session_line"
    __table_args__ = (
        CheckConstraint("position >= 0", name="session_line_position_not_negative"),
        UniqueConstraint(
            "session_id", "position", name="session_line_position_key", deferrable=True, initially="DEFERRED"
        ),
        Index("session_line_exercise", "exercise_id"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("session.id", ondelete="CASCADE"))
    exercise_id: Mapped[int] = mapped_column(ForeignKey("exercise.id", ondelete="RESTRICT"))
    position: Mapped[int]


class SessionSet(Base):
    """A Set: Reps, Weight (lb, as typed), the Warmup mark, and an optional Note."""

    __tablename__ = "session_set"
    __table_args__ = (
        CheckConstraint("position >= 0", name="session_set_position_not_negative"),
        CheckConstraint("reps > 0", name="session_set_reps_positive"),
        CheckConstraint("weight >= 0", name="session_set_weight_not_negative"),
        CheckConstraint("note <> ''", name="session_set_note_not_empty"),
        UniqueConstraint("line_id", "position", name="session_set_position_key", deferrable=True, initially="DEFERRED"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    line_id: Mapped[int] = mapped_column(ForeignKey("session_line.id", ondelete="CASCADE"))
    position: Mapped[int]
    reps: Mapped[int]
    weight: Mapped[Decimal] = mapped_column(Numeric())
    warmup: Mapped[bool] = mapped_column(default=False)
    note: Mapped[str | None]


# Requests


class SetIn(BaseModel):
    """A Set as the screen has it. `id` names a saved Set of the same Line; leave it out for a new one.
    `weight` is a decimal string in lb, as typed ("135", "22.5"). `warmup` defaults to Working."""

    id: int | None = None
    reps: int
    weight: str
    warmup: bool = False
    note: str | None = None


class NewLineIn(BaseModel):
    """A Line of a new Session: the copy of one of the Day's Lines (`day_line_id`), or an extra Line of
    an Exercise, by id (`exercise_id`) or by the name typed (`name`: a live Exercise's name attaches
    it, a new name creates it). Exactly one of the three."""

    day_line_id: int | None = None
    exercise_id: int | None = None
    name: str | None = None
    sets: list[SetIn] = []


class SessionCreate(BaseModel):
    """The first save. `routine_id` and `turn_id` are the Engaged Routine and suggestion the logger
    opened on; `day_lines` are the Day's Line ids it showed, the basis of the Snapshot; `lines` are the
    Lines the screen has, in order, with their Sets. `date` is the logger's date, `today` the browser's."""

    date: dt.date
    today: dt.date
    routine_id: int
    turn_id: int
    day_lines: list[int]
    lines: list[NewLineIn]


class LineIn(BaseModel):
    """A Line of a saved Session: `id` names one of its Lines. A new Line leaves it out and gives its
    Exercise by `exercise_id` or by the `name` typed; new Lines come after the saved ones."""

    id: int | None = None
    exercise_id: int | None = None
    name: str | None = None
    sets: list[SetIn] = []


class SessionWrite(BaseModel):
    """The resulting Lines of the Session, in order, each with its Sets in order. `version` is the
    Session's version the screen was showing."""

    version: int
    lines: list[LineIn]


# Answers


class SetOut(BaseModel):
    id: int
    reps: int
    weight: str
    warmup: bool
    note: str | None


class SessionLineOut(BaseModel):
    id: int
    exercise: ExerciseOut
    sets: list[SetOut]


class Named(BaseModel):
    id: int
    name: str


class SessionOut(BaseModel):
    """A Session with its Routine and Day (current names), its Turn (null when it holds none), and
    its Lines and Sets in order."""

    id: int
    date: dt.date
    routine: Named
    day: Named
    turn_id: int | None
    version: int
    lines: list[SessionLineOut]


router = APIRouter(tags=["sessions"])
DbSession = Annotated[Session, Depends(get_session, scope="function")]

_WEIGHT = re.compile(r"\d{1,6}(\.\d{1,3})?")
MAX_NOTE = 1000


def _session_out(db: Session, record: SessionRecord) -> SessionOut:
    routine = db.get(Routine, record.routine_id)
    day = db.get(Day, record.day_id)
    assert routine is not None and day is not None  # pinned with RESTRICT
    lines = db.execute(
        select(SessionLine, Exercise)
        .join(Exercise, Exercise.id == SessionLine.exercise_id)
        .where(SessionLine.session_id == record.id)
        .order_by(SessionLine.position)
    ).all()
    sets: dict[int, list[SetOut]] = {line.id: [] for line, _ in lines}
    for s in db.scalars(
        select(SessionSet).where(SessionSet.line_id.in_(sets)).order_by(SessionSet.line_id, SessionSet.position)
    ):
        sets[s.line_id].append(SetOut(id=s.id, reps=s.reps, weight=str(s.weight), warmup=s.warmup, note=s.note))
    return SessionOut(
        id=record.id,
        date=record.date,
        routine=Named(id=routine.id, name=routine.name),
        day=Named(id=day.id, name=day.name),
        turn_id=record.turn_id,
        version=record.version,
        lines=[SessionLineOut(id=line.id, exercise=exercises.exercise_out(e), sets=sets[line.id]) for line, e in lines],
    )


def _set_values(s: SetIn) -> tuple[int, Decimal, bool, str | None]:
    """The Set's stored values, or a refusal saying which field is wrong (spec §4.6)."""
    if not 1 <= s.reps <= MAX_ID:
        raise Refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, "reps_invalid", "Reps must be a whole number above 0.")
    typed = s.weight.strip()
    if not _WEIGHT.fullmatch(typed):
        raise Refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "weight_invalid",
            "Weight must be a number of pounds, 0 or more, like 135 or 22.5.",
        )
    note = (s.note or "").strip() or None
    if note is not None and len(note) > MAX_NOTE:
        raise Refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "note_too_long", f"A Note can be at most {MAX_NOTE} characters."
        )
    return s.reps, Decimal(typed), s.warmup, note


def _new_exercises(db: Session, ids: Iterable[int]) -> dict[int, Exercise]:
    """The Exercises new Lines pick, share-locked so they can't be Retired or deleted before commit.
    A missing or Retired one is refused: a new Line can't pick a Retired Exercise (spec §4.1)."""
    wanted = set(ids)
    if any(not 1 <= i <= MAX_ID for i in wanted):
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Exercise no longer exists.")
    found = {e.id: e for e in db.scalars(select(Exercise).where(Exercise.id.in_(wanted)).with_for_update(read=True))}
    if len(found) < len(wanted):
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Exercise no longer exists.")
    for e in found.values():
        if e.retired:
            raise Refusal(
                status.HTTP_409_CONFLICT,
                "exercise_retired",
                f"“{e.name}” is a Retired Exercise. Un-retire it to add it as a new Line.",
            )
    return found


def _line_exercises(db: Session, ids: Iterable[int | None], names: Iterable[str | None]) -> dict[int | str, int]:
    """The Exercise id of each new Line, keyed by the id or the name given. Ids must name live
    Exercises; names attach a live Exercise or create one (spec §4.1). Either way a Retired Exercise is
    refused. Creating one here only adds it to the library."""
    found: dict[int | str, int] = {i: i for i in _new_exercises(db, (i for i in ids if i is not None))}
    for name in names:
        if name is not None and name not in found:
            found[name] = exercises.attach_by_name(db, name).id
    return found


def _no_set_refusal() -> Refusal:
    return Refusal(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "no_set",
        "A Session starts with its first Set. Save a Set to start it; nothing was saved.",
    )


def _write_sets(db: Session, line: SessionLine, sets: Sequence[SetIn], saved: dict[int, SessionSet]) -> None:
    """Make the Line's Sets these, in this order. `saved` are its Sets as they were, by id."""
    keep = {s.id for s in sets if s.id is not None}
    for gone in set(saved) - keep:
        db.delete(saved[gone])
    for position, s in enumerate(sets):
        reps, weight, warmup, note = _set_values(s)
        row = saved[s.id] if s.id is not None else SessionSet(line_id=line.id)
        row.position, row.reps, row.weight, row.warmup, row.note = position, reps, weight, warmup, note
        db.add(row)


def _changed() -> Refusal:
    return Refusal(
        status.HTTP_409_CONFLICT, "session_changed", "This Session changed since you loaded it. Reload and try again."
    )


@router.get("/api/sessions/on/{date}", responses=documented(422))
def session_on(date: dt.date, db: DbSession) -> SessionOut | None:
    """The Session on this civil date, whatever its Routine, or null when there is none."""
    record = db.scalar(select(SessionRecord).where(SessionRecord.date == date))
    return None if record is None else _session_out(db, record)


@router.post("/api/sessions", status_code=status.HTTP_201_CREATED, responses=documented(404, 409, 422))
def create_session(body: SessionCreate, db: DbSession) -> SessionOut:
    """Save the first Set: create the Session from the Snapshot of the suggested Day and the screen's
    Lines and Sets. A write with no Set is not a start and is refused."""
    check_today(body.today)
    for line in body.lines:
        for s in line.sets:
            _set_values(s)
    if not any(line.sets for line in body.lines):
        raise _no_set_refusal()
    if body.date > body.today:
        raise Refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "date_in_future", "A Session can’t be dated in the future."
        )

    routine = engaged_as_seen(db, body.routine_id)  # locked: Session and Skip writes run one at a time
    existing = db.scalar(select(SessionRecord).where(SessionRecord.date == body.date))
    if existing is not None:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "session_exists",
            f"There is already a Session on {shown(body.date)}. It is open now; save your Set there.",
        )
    suggested = suggestion(db, routine)  # before the replacement of this date's Skips
    if suggested is None:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "rotation_empty",
            f"Nothing is on the rotation of “{routine.name}”, so no Session can start.",
        )
    if suggested.turn_id != body.turn_id:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "suggestion_changed",
            f"Up next is now {suggested.day_name}. Check it and try again.",
        )

    # The Snapshot: the Day's Lines as they are now, which must be the ones the logger showed.
    day = db.scalar(select(Day).where(Day.id == suggested.day_id).with_for_update(read=True))
    assert day is not None
    day_lines = {
        dl.id: dl for dl in db.scalars(select(DayLine).where(DayLine.day_id == day.id).order_by(DayLine.position))
    }
    if list(day_lines) != body.day_lines:
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "day_changed",
            f"The Lines of {day.name} changed since you opened it. Check them and try again.",
        )
    used: set[int] = set()
    for line in body.lines:
        if sum(x is not None for x in (line.day_line_id, line.exercise_id, line.name)) != 1:
            raise Refusal(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "invalid_request",
                "Each Line is either one of the Day’s Lines or an extra Exercise.",
            )
        if line.day_line_id is not None:
            if line.day_line_id not in day_lines or line.day_line_id in used:
                raise Refusal(
                    status.HTTP_409_CONFLICT,
                    "day_changed",
                    f"The Lines of {day.name} changed since you opened it. Check them and try again.",
                )
            used.add(line.day_line_id)
    extra = _line_exercises(db, (line.exercise_id for line in body.lines), (line.name for line in body.lines))

    db.execute(delete(Skip).where(Skip.routine_id == routine.id, Skip.date == body.date))
    record = SessionRecord(date=body.date, routine_id=routine.id, day_id=day.id, turn_id=suggested.turn_id)
    db.add(record)
    db.flush()
    for position, line in enumerate(body.lines):
        if line.day_line_id is not None:
            exercise_id = day_lines[line.day_line_id].exercise_id
        else:
            key = line.exercise_id if line.exercise_id is not None else line.name
            assert key is not None
            exercise_id = extra[key]
        row = SessionLine(session_id=record.id, exercise_id=exercise_id, position=position)
        db.add(row)
        db.flush()
        _write_sets(db, row, line.sets, {})
    db.flush()
    return _session_out(db, record)


@router.put("/api/sessions/{session_id}", responses=documented(404, 409, 422))
def write_session(session_id: int, body: SessionWrite, db: DbSession) -> SessionOut | None:
    """Make the Session's Lines and Sets these. Saved Lines and Sets are named by id; Sets stay on
    their Line. A saved Line may be left out (removed) only while it has no Sets. A result with no Set
    erases the Session (null); later logging on that date starts a new one. Never touches the Day."""
    record = db.get(SessionRecord, session_id, with_for_update=True) if 1 <= session_id <= MAX_ID else None
    if record is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Session no longer exists.")
    if body.version != record.version:
        raise _changed()
    for line in body.lines:
        for s in line.sets:
            _set_values(s)

    saved_lines = {line.id: line for line in db.scalars(select(SessionLine).where(SessionLine.session_id == record.id))}
    saved_sets: dict[int, dict[int, SessionSet]] = {line_id: {} for line_id in saved_lines}
    for saved_set in db.scalars(select(SessionSet).where(SessionSet.line_id.in_(saved_lines))):
        saved_sets[saved_set.line_id][saved_set.id] = saved_set
    line_of_set = {set_id: line_id for line_id, sets in saved_sets.items() for set_id in sets}

    seen_lines: set[int] = set()
    seen_sets: set[int] = set()
    for line in body.lines:
        if line.id is not None:
            if line.id not in saved_lines or line.id in seen_lines:
                raise _changed()
            if line.exercise_id is not None and line.exercise_id != saved_lines[line.id].exercise_id:
                raise Refusal(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "invalid_request",
                    "A Line keeps its Exercise. Add a new Line for another Exercise.",
                )
            if line.name is not None:
                raise Refusal(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "invalid_request",
                    "A Line keeps its Exercise. Add a new Line for another Exercise.",
                )
            seen_lines.add(line.id)
        elif (line.exercise_id is None) == (line.name is None):
            raise Refusal(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "invalid_request",
                "A new Line needs an Exercise, by id or by name.",
            )
        for s in line.sets:
            if s.id is None:
                continue
            if s.id not in line_of_set or s.id in seen_sets:
                raise _changed()
            if line_of_set[s.id] != line.id:
                raise Refusal(
                    status.HTTP_409_CONFLICT, "set_moved", "Sets never move across Lines. Delete it and save it again."
                )
            seen_sets.add(s.id)
    kept = [line.id for line in body.lines if line.id is not None]
    first_new = next((i for i, line in enumerate(body.lines) if line.id is None), len(body.lines))
    if kept != sorted(kept, key=lambda i: saved_lines[i].position) or any(
        line.id is not None for line in body.lines[first_new:]
    ):
        raise Refusal(
            status.HTTP_409_CONFLICT,
            "lines_reordered",
            "A Session’s Lines keep their order, and a new Line goes at the end.",
        )
    for gone in set(saved_lines) - seen_lines:
        if saved_sets[gone]:
            raise Refusal(
                status.HTTP_409_CONFLICT,
                "line_has_sets",
                "A Line can be removed only while it has no Sets. Delete its Sets first.",
            )
    if not any(line.sets for line in body.lines):  # dissolve: no Set left, no Session
        db.delete(record)
        db.flush()
        return None
    new = [line for line in body.lines if line.id is None]
    extra = _line_exercises(db, (line.exercise_id for line in new), (line.name for line in new))

    for gone in set(saved_lines) - seen_lines:
        db.delete(saved_lines[gone])
    for position, line in enumerate(body.lines):
        if line.id is not None:
            row = saved_lines[line.id]
            row.position = position
        else:
            key = line.exercise_id if line.exercise_id is not None else line.name
            assert key is not None
            row = SessionLine(session_id=record.id, exercise_id=extra[key], position=position)
            db.add(row)
            db.flush()
        _write_sets(db, row, line.sets, saved_sets.get(row.id, {}))
    record.version += 1
    db.flush()
    return _session_out(db, record)


@router.delete("/api/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT, responses=documented(404, 422))
def delete_session(session_id: int, db: DbSession) -> None:
    """Delete the Session with its Lines and Sets. Skips it replaced are not restored, and later Skips
    stay. Logging that date again creates a new Session."""
    record = db.get(SessionRecord, session_id, with_for_update=True) if 1 <= session_id <= MAX_ID else None
    if record is None:
        raise Refusal(status.HTTP_404_NOT_FOUND, "not_found", "That Session no longer exists.")
    db.delete(record)
    db.flush()
