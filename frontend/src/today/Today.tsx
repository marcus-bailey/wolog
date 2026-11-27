import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { messageOf, Refused } from '../api';
import { localToday, shownDate } from '../dates';
import { getDay } from '../routines/api';
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
const STALE_START = ['routine_switched', 'suggestion_changed', 'rotation_empty', 'no_routine', 'day_changed'];
/** Refusals of a Session write that mean the screen missed a change: reload the Session. */
const STALE_SESSION = ['session_exists', 'session_changed', 'not_found', 'line_has_sets', 'set_moved', 'lines_reordered'];

/** Open the logger on Up next's suggested Day for `on`; saves nothing. Null when there's none. */
async function draftOn(next: UpNext, on: string): Promise<Logging | null> {
  if (!next.routine || !next.suggestion) return null;
  const day = await getDay(next.suggestion.day_id);
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
 */
export function Today() {
  const { routines, reload: reloadRoutines } = useRoutines();
  const engagedId = routines?.find((r) => r.engaged)?.id;
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const [logging, setLogging] = useState<Logging | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    const on = open?.kind === 'draft' ? open.date : open?.kind === 'session' ? open.session.date : today;
    Promise.all([getUpNext(), getSessionOn(on)])
      .then(async ([next, session]) => {
        const reopened = session
          ? ({ kind: 'session', session } as const)
          : open?.kind === 'draft'
            ? await draftOn(next, on)
            : null;
        if (!current) return;
        setUpNext(next);
        setLogging(reopened);
        setLoadError(null);
      })
      .catch((e: unknown) => current && setLoadError(messageOf(e)));
    return () => {
      current = false;
    };
  }, [engagedId, today]);

  async function act(action: () => Promise<UpNext>) {
    setBusy(true);
    setError(null);
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
      setLogging(session ? { kind: 'session', session } : await draftOn(upNext, today));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  /** The logger's date changed: a date that has a Session opens it; otherwise the draft moves there. */
  async function onDate(on: string) {
    if (logging?.kind !== 'draft') return;
    setError(null);
    setLogging({ ...logging, date: on });
    try {
      const session = await getSessionOn(on);
      if (session) setLogging({ kind: 'session', session });
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function onClose() {
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
  function write(change: (lines: ReturnType<typeof postState>) => LineWrite[]): Promise<boolean> {
    if (logging?.kind !== 'session') return Promise.resolve(false);
    const session = logging.session;
    return attempt(async () => {
      const after = await writeSession(session, change(postState(session)));
      if (after) {
        setLogging({ kind: 'session', session: after });
      } else {
        setLogging(null);
        setNotice('The Session is gone: it had no Sets left.');
        setUpNext(await getUpNext());
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
          dayLines: draft.day.lines.map((l) => l.id),
          lines: draft.lines.map((l, i) => ({
            ...('dayLineId' in l ? { day_line_id: l.dayLineId } : { name: l.name }),
            sets: i === lineIndex ? [set] : [],
          })),
        });
        setLogging({ kind: 'session', session });
        setUpNext(await getUpNext());
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
        setLogging(null);
        setNotice('Session deleted.');
        setUpNext(await getUpNext());
      });
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
        if (!session) setUpNext(await getUpNext());
      } else if (logging.kind === 'draft' && STALE_START.includes(code)) {
        await reloadRoutines();
        const next = await getUpNext();
        setUpNext(next);
        setLogging(await draftOn(next, on));
      }
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
              <p className="quiet">
                Turn {suggestion.position} of {suggestion.of}
              </p>
              <p className="suggested-day">{suggestion.day_name}</p>
              <div className="row actions">
                <button type="button" disabled={busy} onClick={() => void onStart()}>
                  Start {suggestion.day_name}
                </button>
              </div>
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
