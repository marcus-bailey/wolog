import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { messageOf, Refused } from '../api';
import { localToday, shownDate } from '../dates';
import { getDay, getRoutine } from '../routines/api';
import { useRoutines } from '../routines/RoutinesContext';
import {
  createSession,
  deleteSession,
  getSessionOn,
  writeSession,
  type LineWrite,
  type Session,
  type SetValues,
} from '../sessions/api';
import { getUpNext, skip, undoSkip, type UpNext } from './api';
import { Logger, type LoggerActions, type Logging } from './Logger';

/** Refusals that mean the screen is out of date: reload Up next (and the Routines). */
const STALE = ['routine_switched', 'suggestion_changed', 'not_last_skip', 'not_found', 'rotation_empty', 'no_routine'];
/** Refusals of a first save that mean the logger reloads on the current suggestion (spec §4.5, LOG-8). */
const STALE_START = ['routine_switched', 'suggestion_changed', 'rotation_empty', 'no_routine', 'day_changed', 'day_off_rotation'];
/** Refusals of a Session write that mean the screen missed a change: reload the Session. */
const STALE_SESSION = ['session_exists', 'session_changed', 'not_found', 'line_has_sets', 'set_moved', 'lines_reordered'];

/** A Day of the rotation, as Pick another Day lists it. */
interface PickedDay {
  id: number;
  name: string;
}

/**
 * Open the logger for `on` on Up next's suggested Day, or on the Day picked instead; saves nothing.
 * Null when there's no suggestion.
 */
async function draftOn(next: UpNext, on: string, picked: PickedDay | null = null): Promise<Logging | null> {
  if (!next.routine || !next.suggestion) return null;
  const day = await getDay(picked?.id ?? next.suggestion.day_id);
  const lines = day.lines.map((l) => ({ key: `d${l.id}`, dayLineId: l.id, exercise: l.exercise }));
  return { kind: 'draft', routine: next.routine, suggestion: next.suggestion, day, date: on, lines };
}

/** The Session's Lines and Sets as a post-state to change. */
function postState(session: Session): (LineWrite & { sets: SetValues[] })[] {
  return session.lines.map((l) => ({ id: l.id, sets: [...l.sets] }));
}

let draftKeys = 0;

/**
 * Today (spec §5). Before a Session: an Up next card for the Engaged Routine with the Routine name,
 * "Turn n of N" and the suggested Day, Start ‹Day›, Skip it, and Undo last Skip when there is one.
 * The rotation itself is not shown. With no Routine, it points the owner to create one; with an
 * empty rotation, it says so and links to the Routine editor, and offers no Skip.
 *
 * Start only opens the Lines in the logger; nothing is saved until the first Set, which creates the
 * Session from the screen's Lines. A date that has a Session (whatever its Routine) opens that
 * Session, which stays editable: every change is written as the Session's whole post-state. A write
 * that leaves no Set, or Delete Session, erases it and goes back to Up next.
 *
 * `on` opens the Session on that date instead (from History); leaving it comes back to today.
 */
export function Today({ on: opened }: { on?: string } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  /** Leave a Session opened from History for a fresh Today, saying why when there's a reason. */
  const leaveOpened = (why?: string) => navigate('/', { replace: true, state: why ? { notice: why } : null });
  const { routines, reload: reloadRoutines } = useRoutines();
  const engagedId = routines?.find((r) => r.engaged)?.id;
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const [logging, setLogging] = useState<Logging | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const state: unknown = location.state;
    return typeof state === 'object' && state !== null && 'notice' in state && typeof state.notice === 'string'
      ? state.notice
      : null;
  });
  /** Pick another Day: the rotation's Days while choosing, and the Day picked over the suggestion. */
  const [rotationDays, setRotationDays] = useState<PickedDay[] | null>(null);
  const [picked, setPicked] = useState<PickedDay | null>(null);
  const [busy, setBusy] = useState(false);
  // Filled when the screen opens; it does not roll at midnight.
  const [today] = useState(localToday);
  const [date, setDate] = useState(today);
  const loggingRef = useRef(logging);
  useEffect(() => {
    loggingRef.current = logging;
  });

  // Again whenever the Engaged Routine changes (e.g. a switch from the drawer). Today's Session
  // stays open whatever its Routine; an open draft reloads on the new suggestion.
  useEffect(() => {
    let current = true;
    const open = loggingRef.current;
    const on = open?.kind === 'draft' ? open.date : open?.kind === 'session' ? open.session.date : (opened ?? today);
    Promise.all([getUpNext(), getSessionOn(on)])
      .then(async ([next, session]) => {
        const reopened = session
          ? ({ kind: 'session', session } as const)
          : open?.kind === 'draft'
            ? await draftOn(on === today ? next : await getUpNext(on), on)
            : null;
        if (!current) return;
        if (opened !== undefined && !session) {
          leaveOpened(`There is no Session on ${shownDate(opened, today)} any more.`);
          return;
        }
        setUpNext(next);
        setPicked(null);
        setRotationDays(null);
        setLogging(reopened);
        setLoadError(null);
      })
      .catch((e: unknown) => current && setLoadError(messageOf(e)));
    return () => {
      current = false;
    };
    // leaveOpened is the same navigation every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagedId, today, opened]);

  async function act(action: () => Promise<UpNext>) {
    setBusy(true);
    setError(null);
    setPicked(null);
    setRotationDays(null);
    try {
      setUpNext(await action());
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof Refused && STALE.includes(e.code)) {
        await reloadRoutines();
        setUpNext(await getUpNext());
      }
    } finally {
      setBusy(false);
    }
  }

  async function onStart() {
    if (!upNext) return;
    setBusy(true);
    setError(null);
    try {
      const session = await getSessionOn(today);
      setLogging(session ? { kind: 'session', session } : await draftOn(upNext, today, picked));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The logger's date changed: a date that has a Session opens it; otherwise the draft moves there,
   * on the suggestion as of that date (a backfill's pre-selection, spec §4.4). A picked Day stays.
   */
  async function onDate(on: string) {
    if (logging?.kind !== 'draft') return;
    const draft = logging;
    const kept = draft.day.id === draft.suggestion.day_id ? null : { id: draft.day.id, name: draft.day.name };
    setError(null);
    setLogging({ ...draft, date: on });
    // No save until the draft is on the suggestion as of its new date.
    setBusy(true);
    try {
      const [session, next] = await Promise.all([getSessionOn(on), getUpNext(on)]);
      const moved = session ? ({ kind: 'session', session } as const) : await draftOn(next, on, kept);
      // Unless the date changed again meanwhile.
      setLogging((now) => {
        if (now?.kind !== 'draft' || now.date !== on || !moved) return now;
        if (moved.kind === 'session') return moved;
        // The same Day keeps the screen's Lines; another Day keeps the Lines added by name.
        const typed = now.lines.filter((l) => 'name' in l);
        return { ...moved, lines: moved.day.id === draft.day.id ? now.lines : [...moved.lines, ...typed] };
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function onClose() {
    if (opened !== undefined) {
      leaveOpened();
      return;
    }
    setError(null);
    try {
      const session = await getSessionOn(today);
      setLogging(session ? { kind: 'session', session } : null);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** Run a Session write; show a refusal, and reload what it says changed. */
  async function attempt(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof Refused) await recover(e.code);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Write the Session's post-state after `change`. No Set left means the Session is gone. */
  function write(change: (lines: ReturnType<typeof postState>) => LineWrite[], dayId?: number): Promise<boolean> {
    if (logging?.kind !== 'session') return Promise.resolve(false);
    const session = logging.session;
    return attempt(async () => {
      const after = await writeSession(session, change(postState(session)), dayId);
      if (after) {
        setLogging({ kind: 'session', session: after });
        if (dayId !== undefined) showUpNext(await getUpNext()); // the re-pinned Turn may move the cursor
      } else {
        if (opened !== undefined) return leaveOpened('The Session is gone: it had no Sets left.');
        setLogging(null);
        setNotice('The Session is gone: it had no Sets left.');
        showUpNext(await getUpNext());
      }
    });
  }

  function validReps(set: SetValues): boolean {
    if (Number.isInteger(set.reps) && set.reps >= 1) return true;
    setError('Reps must be a whole number above 0.');
    return false;
  }

  const actions: LoggerActions = {
    saveSet(lineIndex, set) {
      if (!logging || !validReps(set)) return Promise.resolve(false);
      if (logging.kind === 'session') {
        return write((lines) => lines.map((l, i) => (i === lineIndex ? { ...l, sets: [...l.sets, set] } : l)));
      }
      const draft = logging;
      return attempt(async () => {
        const session = await createSession({
          date: draft.date,
          routineId: draft.routine.id,
          turnId: draft.suggestion.turn_id,
          ...(draft.day.id === draft.suggestion.day_id ? {} : { dayId: draft.day.id }),
          dayLines: draft.day.lines.map((l) => l.id),
          lines: draft.lines.map((l, i) => ({
            ...('dayLineId' in l ? { day_line_id: l.dayLineId } : { name: l.name }),
            sets: i === lineIndex ? [set] : [],
          })),
        });
        setLogging({ kind: 'session', session });
        showUpNext(await getUpNext());
      });
    },
    editSet(lineIndex, setIndex, set) {
      if (set && !validReps(set)) return Promise.resolve(false);
      return write((lines) =>
        lines.map((l, i) =>
          i !== lineIndex
            ? l
            : { ...l, sets: set ? l.sets.map((s, j) => (j === setIndex ? set : s)) : l.sets.filter((_, j) => j !== setIndex) },
        ),
      );
    },
    moveSet(lineIndex, setIndex, by) {
      return write((lines) =>
        lines.map((l, i) => {
          if (i !== lineIndex) return l;
          const sets = [...l.sets];
          const [moved] = sets.splice(setIndex, 1);
          sets.splice(setIndex + by, 0, moved!);
          return { ...l, sets };
        }),
      );
    },
    addLine(name) {
      if (logging?.kind === 'draft') {
        setLogging({ ...logging, lines: [...logging.lines, { key: `n${++draftKeys}`, name }] });
        return Promise.resolve(true);
      }
      return write((lines) => [...lines, { name, sets: [] }]);
    },
    removeLine(lineIndex) {
      if (logging?.kind === 'draft') {
        setLogging({ ...logging, lines: logging.lines.filter((_, i) => i !== lineIndex) });
        return Promise.resolve(true);
      }
      return write((lines) => lines.filter((_, i) => i !== lineIndex));
    },
    deleteSession() {
      if (logging?.kind !== 'session') return Promise.resolve(false);
      const id = logging.session.id;
      return attempt(async () => {
        await deleteSession(id);
        if (opened !== undefined) return leaveOpened('Session deleted.');
        setLogging(null);
        setNotice('Session deleted.');
        showUpNext(await getUpNext());
      });
    },
    changeDay(dayId) {
      return write((lines) => lines, dayId);
    },
    changeDate: (on) => void onDate(on),
    close: () => void onClose(),
  };

  /** After a refused write: reload what the refusal says changed. */
  async function recover(code: string) {
    if (!logging) return;
    const on = logging.kind === 'draft' ? logging.date : logging.session.date;
    try {
      if (STALE_SESSION.includes(code)) {
        const session = await getSessionOn(on);
        setLogging(session ? { kind: 'session', session } : null);
        if (!session) showUpNext(await getUpNext());
      } else if (logging.kind === 'draft' && STALE_START.includes(code)) {
        await reloadRoutines();
        const next = await getUpNext();
        showUpNext(next);
        setLogging(await draftOn(on === today ? next : await getUpNext(on), on));
      }
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** Show a fresh Up next. A pick is made against one suggestion, so it goes with it. */
  function showUpNext(next: UpNext) {
    setUpNext(next);
    setPicked(null);
    setRotationDays(null);
  }

  /** Pick another Day: list the Days on the rotation, each once, in the order of their first Turn. */
  async function onPickAnother() {
    if (!upNext?.routine) return;
    setError(null);
    try {
      const detail = await getRoutine(upNext.routine.id);
      const ids = [...new Set(detail.rotation.map((t) => t.day_id))];
      setRotationDays(ids.map((id) => ({ id, name: detail.days.find((d) => d.id === id)?.name ?? '' })));
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const routine = upNext?.routine;
  const suggestion = upNext?.suggestion;
  const lastSkip = upNext?.last_skip;

  const onSkip = (event: FormEvent) => {
    event.preventDefault();
    if (!routine || !suggestion) return;
    void act(() => skip(routine.id, suggestion.turn_id, date));
  };

  const refusal = error && (
    <p role="alert" className="refusal">
      {error}
    </p>
  );

  return (
    <main className="screen">
      <h1>Today</h1>
      {notice && (
        <p role="status" className="quiet">
          {notice}
        </p>
      )}
      {loadError ? (
        <p role="alert" className="refusal">
          {loadError}
        </p>
      ) : !upNext ? (
        <p className="quiet">Loading…</p>
      ) : logging ? (
        <>
          <Logger
            // A draft becoming its Session keeps the screen (the current Line, Weight and Reps).
            key={logging.kind === 'draft' ? logging.date : logging.session.date}
            logging={logging}
            today={today}
            busy={busy}
            actions={actions}
          />
          {refusal}
        </>
      ) : !routine ? (
        <div className="card">
          <p>No Routine yet. Create one to start logging.</p>
          <Link className="button" to="/routines">
            Create a Routine
          </Link>
        </div>
      ) : (
        <section className="card" aria-labelledby="up-next-heading">
          <h2 id="up-next-heading" className="eyebrow">
            Up next · {routine.name}
          </h2>
          {suggestion ? (
            <>
              {picked ? (
                <p className="quiet">Suggested: {suggestion.day_name}</p>
              ) : (
                <p className="quiet">
                  Turn {suggestion.position} of {suggestion.of}
                </p>
              )}
              <p className="suggested-day">{(picked ?? { name: suggestion.day_name }).name}</p>
              <div className="row actions">
                <button type="button" disabled={busy} onClick={() => void onStart()}>
                  Start {(picked ?? { name: suggestion.day_name }).name}
                </button>
                {picked ? (
                  <button type="button" className="secondary" onClick={() => setPicked(null)}>
                    Back to {suggestion.day_name}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    aria-expanded={rotationDays !== null}
                    onClick={() => (rotationDays ? setRotationDays(null) : void onPickAnother())}
                  >
                    Pick another Day
                  </button>
                )}
              </div>
              {rotationDays && !picked && (
                <div className="chips pick-day" role="group" aria-label="Days on the rotation">
                  {rotationDays.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="chip"
                      onClick={() => {
                        setPicked(d.id === suggestion.day_id ? null : d);
                        setRotationDays(null);
                      }}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>
              )}
              {!picked && (
              <form className="skip" onSubmit={onSkip}>
                <label htmlFor="skip-date">Skip date</label>
                <div className="row">
                  <input
                    id="skip-date"
                    type="date"
                    value={date}
                    max={today}
                    required
                    onChange={(e) => setDate(e.target.value)}
                  />
                  <button type="submit" className="secondary" disabled={busy}>
                    Skip it
                  </button>
                </div>
              </form>
              )}
            </>
          ) : (
            <>
              <p>Nothing is on the rotation.</p>
              <Link className="button" to={`/routines/${routine.id}`}>
                Open {routine.name}
              </Link>
            </>
          )}
          {lastSkip && (
            <div className="row actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void act(() => undoSkip(lastSkip.id))}
              >
                Undo last Skip ({lastSkip.day_name}, {shownDate(lastSkip.date, today)})
              </button>
            </div>
          )}
          {refusal}
        </section>
      )}
    </main>
  );
}
