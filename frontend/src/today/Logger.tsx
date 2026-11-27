import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { shownDate } from '../dates';
import type { Exercise } from '../exercises/api';
import type { Day } from '../routines/api';
import type { SavedSet, Session, SetValues } from '../sessions/api';
import type { Suggestion } from './api';

/**
 * What the logger has open: the suggested Day before its first Set (nothing saved yet), or a Session.
 * `date` is the logger's date field, filled with the browser's today when it opens.
 */
export type Logging =
  | { kind: 'draft'; routine: { id: number; name: string }; suggestion: Suggestion; day: Day; date: string }
  | { kind: 'session'; session: Session };

interface ScreenLine {
  key: string;
  exercise: Exercise;
  sets: SavedSet[];
}

function screenLines(logging: Logging): ScreenLine[] {
  return logging.kind === 'draft'
    ? logging.day.lines.map((l) => ({ key: `d${l.id}`, exercise: l.exercise, sets: [] }))
    : logging.session.lines.map((l) => ({ key: `s${l.id}`, exercise: l.exercise, sets: l.sets }));
}

/** Step a typed number, never below `min`. Empty or unreadable counts as 0. */
function step(value: string, by: number, min: number): string {
  const n = Number(value.trim() === '' ? 0 : value);
  const next = Math.max(min, (Number.isFinite(n) ? n : 0) + by);
  return String(Math.round(next * 1000) / 1000);
}

/**
 * Today, logging (spec §5, Focus layout): one Line at a time. A chip strip of the Lines with their
 * Set counts; the current Line's Exercise, today's Sets as chips (Warmups tinted, a Note as a dot),
 * Weight (−5 / +5) and Reps (−1 / +1) steppers with editable values, a Warmup toggle, a Note and a
 * large Save Set N; Previous and Next Line.
 *
 * `onSave` saves a Set on the Line at that index and resolves true when it was saved. After a save
 * Weight and Reps stay as they were, the mark resets to Working and the Note to blank; moving to
 * another Line clears the inputs.
 */
export function Logger({
  logging,
  today,
  busy,
  onSave,
  onDate,
  onClose,
}: {
  logging: Logging;
  today: string;
  busy: boolean;
  onSave: (lineIndex: number, set: SetValues) => Promise<boolean>;
  onDate: (date: string) => void;
  onClose: () => void;
}) {
  const lines = screenLines(logging);
  const [current, setCurrent] = useState(0);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [warmup, setWarmup] = useState(false);
  const [note, setNote] = useState('');

  const index = Math.min(current, Math.max(0, lines.length - 1));
  const line = lines[index];
  const routine = logging.kind === 'draft' ? logging.routine : logging.session.routine;
  const dayName = logging.kind === 'draft' ? logging.day.name : logging.session.day.name;
  const date = logging.kind === 'draft' ? logging.date : logging.session.date;

  function goTo(i: number) {
    if (i === index) return;
    setCurrent(i);
    setWeight('');
    setReps('');
    setWarmup(false);
    setNote('');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await onSave(index, {
      reps: Number(reps),
      weight: weight.trim(),
      warmup,
      note: note.trim() === '' ? null : note.trim(),
    });
    if (saved) {
      setWarmup(false);
      setNote('');
    }
  }

  return (
    <section className="logger" aria-label="Logger">
      <header className="logger-head">
        <p className="eyebrow">{routine.name}</p>
        <h2 className="logger-day">{dayName}</h2>
        {logging.kind === 'draft' ? (
          <div className="row logger-date">
            <label htmlFor="logger-date">Date</label>
            <input
              id="logger-date"
              type="date"
              value={date}
              max={today}
              required
              onChange={(e) => e.target.value && onDate(e.target.value)}
            />
            <button type="button" className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <div className="row logger-date">
            <p className="quiet">{date === today ? 'Today' : shownDate(date, today)}</p>
            {date !== today && (
              <button type="button" className="secondary" onClick={onClose}>
                Back to today
              </button>
            )}
          </div>
        )}
      </header>

      {!line ? (
        <div className="card">
          <p>{dayName} has no Lines.</p>
          <Link className="button" to={`/routines/${routine.id}`}>
            Open {routine.name}
          </Link>
        </div>
      ) : (
        <>
          <nav className="chips line-strip" aria-label="Lines">
            {lines.map((l, i) => (
              <button
                key={l.key}
                type="button"
                className="chip"
                aria-current={i === index ? 'true' : undefined}
                onClick={() => goTo(i)}
              >
                {l.exercise.name} <span className="count">{l.sets.length}</span>
              </button>
            ))}
          </nav>

          <h3 className="exercise-name">{line.exercise.name}</h3>

          {line.sets.length > 0 && (
            <ol className="chips sets" aria-label="Today’s Sets">
              {line.sets.map((s) => (
                <li key={s.id} className={s.warmup ? 'chip set warmup' : 'chip set'}>
                  {s.weight} × {s.reps}
                  {s.warmup && <span className="visually-hidden"> Warmup</span>}
                  {s.note && (
                    <span className="note-dot" title={s.note}>
                      <span aria-hidden="true">•</span>
                      <span className="visually-hidden"> Note</span>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}

          <form className="set-form" onSubmit={(e) => void onSubmit(e)}>
            <div className="stepper">
              <label htmlFor="weight">Weight (lb)</label>
              <div className="row">
                <button type="button" className="secondary" aria-label="Weight −5" onClick={() => setWeight(step(weight, -5, 0))}>
                  −5
                </button>
                <input
                  id="weight"
                  inputMode="decimal"
                  autoComplete="off"
                  value={weight}
                  required
                  onChange={(e) => setWeight(e.target.value)}
                />
                <button type="button" className="secondary" aria-label="Weight +5" onClick={() => setWeight(step(weight, 5, 0))}>
                  +5
                </button>
              </div>
            </div>
            <div className="stepper">
              <label htmlFor="reps">Reps</label>
              <div className="row">
                <button type="button" className="secondary" aria-label="Reps −1" onClick={() => setReps(step(reps, -1, 1))}>
                  −1
                </button>
                <input
                  id="reps"
                  inputMode="numeric"
                  autoComplete="off"
                  value={reps}
                  required
                  onChange={(e) => setReps(e.target.value)}
                />
                <button type="button" className="secondary" aria-label="Reps +1" onClick={() => setReps(step(reps, 1, 1))}>
                  +1
                </button>
              </div>
            </div>
            <div className="row">
              <button
                type="button"
                className="secondary toggle"
                aria-pressed={warmup}
                onClick={() => setWarmup(!warmup)}
              >
                {warmup ? 'Warmup' : 'Working'}
              </button>
            </div>
            <label htmlFor="note">Note</label>
            <input id="note" value={note} autoComplete="off" onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className="save-set" disabled={busy}>
              Save Set {line.sets.length + 1}
            </button>
          </form>

          <div className="row line-nav">
            <button type="button" className="secondary" disabled={index === 0} onClick={() => goTo(index - 1)}>
              Previous Line
            </button>
            <button
              type="button"
              className="secondary"
              disabled={index === lines.length - 1}
              onClick={() => goTo(index + 1)}
            >
              Next Line
            </button>
          </div>
        </>
      )}
    </section>
  );
}
