import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { messageOf, Refused } from '../api';
import { localToday, shownDate } from '../dates';
import { useRoutines } from '../routines/RoutinesContext';
import { getUpNext, skip, undoSkip, type UpNext } from './api';

/** Refusals that mean the screen is out of date: reload Up next (and the Routines). */
const STALE = ['routine_switched', 'suggestion_changed', 'not_last_skip', 'not_found', 'rotation_empty'];

/**
 * Today, before a Session (spec §5): an Up next card for the Engaged Routine with the Routine name,
 * "Turn n of N" and the suggested Day, Skip it, and Undo last Skip when there is one. The rotation
 * itself is not shown. With no Routine, it points the owner to create one; with an empty rotation, it
 * says so and links to the Routine editor, and offers no Skip.
 */
export function Today() {
  const { routines, reload: reloadRoutines } = useRoutines();
  const engagedId = routines?.find((r) => r.engaged)?.id;
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Filled when the screen opens; it does not roll at midnight.
  const [today] = useState(localToday);
  const [date, setDate] = useState(today);

  // Again whenever the Engaged Routine changes (e.g. a switch from the drawer).
  useEffect(() => {
    getUpNext().then(
      (next) => {
        setUpNext(next);
        setLoadError(null);
      },
      (e: unknown) => setLoadError(messageOf(e)),
    );
  }, [engagedId]);

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

  const routine = upNext?.routine;
  const suggestion = upNext?.suggestion;
  const lastSkip = upNext?.last_skip;

  const onSkip = (event: FormEvent) => {
    event.preventDefault();
    if (!routine || !suggestion) return;
    void act(() => skip(routine.id, suggestion.turn_id, date));
  };

  return (
    <main className="screen">
      <h1>Today</h1>
      {loadError ? (
        <p role="alert" className="refusal">
          {loadError}
        </p>
      ) : !upNext ? (
        <p className="quiet">Loading…</p>
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
          {error && (
            <p role="alert" className="refusal">
              {error}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
