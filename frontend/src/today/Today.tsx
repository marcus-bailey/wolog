import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { messageOf, Refused } from '../api';
import { localToday, shownDate } from '../dates';
import { getDay } from '../routines/api';
import { useRoutines } from '../routines/RoutinesContext';
import { createSession, getSessionOn, writeSession, type SetValues } from '../sessions/api';
import { getUpNext, skip, undoSkip, type UpNext } from './api';
import { Logger, type Logging } from './Logger';

/** Refusals that mean the screen is out of date: reload Up next (and the Routines). */
const STALE = ['routine_switched', 'suggestion_changed', 'not_last_skip', 'not_found', 'rotation_empty', 'no_routine'];
/** Refusals of a first save that mean the logger reloads on the current suggestion (spec §4.5, LOG-8). */
const STALE_START = ['routine_switched', 'suggestion_changed', 'rotation_empty', 'no_routine', 'day_changed'];

/** Open the logger on Up next's suggested Day for `on`; saves nothing. Null when there's none. */
async function draftOn(next: UpNext, on: string): Promise<Logging | null> {
  if (!next.routine || !next.suggestion) return null;
  const day = await getDay(next.suggestion.day_id);
  return { kind: 'draft', routine: next.routine, suggestion: next.suggestion, day, date: on };
}

/**
 * Today (spec §5). Before a Session: an Up next card for the Engaged Routine with the Routine name,
 * "Turn n of N" and the suggested Day, Start ‹Day›, Skip it, and Undo last Skip when there is one.
 * The rotation itself is not shown. With no Routine, it points the owner to create one; with an
 * empty rotation, it says so and links to the Routine editor, and offers no Skip.
 *
 * Start only opens the Lines in the logger; nothing is saved until the first Set, which creates the
 * Session. A date that has a Session (whatever its Routine) opens that Session.
 */
export function Today() {
  const { routines, reload: reloadRoutines } = useRoutines();
  const engagedId = routines?.find((r) => r.engaged)?.id;
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const [logging, setLogging] = useState<Logging | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  async function onSave(lineIndex: number, set: SetValues): Promise<boolean> {
    if (!logging) return false;
    if (!Number.isInteger(set.reps) || set.reps < 1) {
      setError('Reps must be a whole number above 0.');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      if (logging.kind === 'draft') {
        const session = await createSession({
          date: logging.date,
          routineId: logging.routine.id,
          turnId: logging.suggestion.turn_id,
          dayLines: logging.day.lines.map((l) => l.id),
          lines: logging.day.lines.map((l, i) => ({ day_line_id: l.id, sets: i === lineIndex ? [set] : [] })),
        });
        setLogging({ kind: 'session', session });
        setUpNext(await getUpNext());
      } else {
        const session = await writeSession(
          logging.session.id,
          logging.session.lines.map((l, i) => ({ id: l.id, sets: i === lineIndex ? [...l.sets, set] : l.sets })),
        );
        setLogging(session ? { kind: 'session', session } : null);
      }
      return true;
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof Refused) await recover(e.code);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** After a refused save: reload what the refusal says changed. */
  async function recover(code: string) {
    if (!logging) return;
    const on = logging.kind === 'draft' ? logging.date : logging.session.date;
    try {
      if (code === 'session_exists' || code === 'session_changed' || code === 'not_found') {
        const session = await getSessionOn(on);
        setLogging(session ? { kind: 'session', session } : null);
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
            onSave={onSave}
            onDate={(on) => void onDate(on)}
            onClose={() => void onClose()}
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
