import { useEffect, useState, type FormEvent } from 'react';
import { messageOf } from '../api';
import { shownDate } from '../dates';
import { listExercises, type Exercise } from '../exercises/api';
import type { Day } from '../routines/api';
import type { SavedSet, Session, SetValues } from '../sessions/api';
import type { Suggestion } from './api';

/** A Line on the screen before the first Set: a copy of one of the Day's Lines, or one typed by name. */
export type DraftLine = { key: string; dayLineId: number; exercise: Exercise } | { key: string; name: string };

/**
 * What the logger has open: the suggested Day before its first Set (nothing saved yet; the screen's
 * Lines start as the Day's), or a Session. `date` is the logger's date field, filled with the
 * browser's today when it opens.
 */
export type Logging =
  | {
      kind: 'draft';
      routine: { id: number; name: string };
      suggestion: Suggestion;
      day: Day;
      date: string;
      lines: DraftLine[];
    }
  | { kind: 'session'; session: Session };

/** What the logger asks of Today. Each resolves true when it was done. */
export interface LoggerActions {
  saveSet: (lineIndex: number, set: SetValues) => Promise<boolean>;
  /** Edit a saved Set's fields, or delete it (null). */
  editSet: (lineIndex: number, setIndex: number, set: SetValues | null) => Promise<boolean>;
  /** Move a saved Set earlier (-1) or later (1) within its Line. */
  moveSet: (lineIndex: number, setIndex: number, by: -1 | 1) => Promise<boolean>;
  /** Add a Line at the end: a live Exercise's name attaches it; a new name creates it. */
  addLine: (name: string) => Promise<boolean>;
  /** Remove a Line that has no Sets. */
  removeLine: (lineIndex: number) => Promise<boolean>;
  deleteSession: () => Promise<boolean>;
  changeDate: (date: string) => void;
  close: () => void;
}

interface ScreenLine {
  key: string;
  name: string;
  sets: SavedSet[];
}

const normalised = (name: string) => name.trim().replace(/\s+/g, ' ');

function screenLines(logging: Logging): ScreenLine[] {
  return logging.kind === 'draft'
    ? logging.lines.map((l) => ({ key: l.key, name: 'name' in l ? normalised(l.name) : l.exercise.name, sets: [] }))
    : logging.session.lines.map((l) => ({ key: `s${l.id}`, name: l.exercise.name, sets: l.sets }));
}

/** Step a typed number, never below `min`. Empty or unreadable counts as 0. */
function step(value: string, by: number, min: number): string {
  const n = Number(value.trim() === '' ? 0 : value);
  const next = Math.max(min, (Number.isFinite(n) ? n : 0) + by);
  return String(Math.round(next * 1000) / 1000);
}

/** The values typed into Set inputs, as the API takes them. */
function values(weight: string, reps: string, warmup: boolean, note: string): SetValues {
  return { reps: Number(reps), weight: weight.trim(), warmup, note: note.trim() === '' ? null : note.trim() };
}

/** Weight (−5 / +5) and Reps (−1 / +1) steppers with directly editable values. */
function Steppers({
  prefix,
  weight,
  reps,
  setWeight,
  setReps,
}: {
  prefix: string;
  weight: string;
  reps: string;
  setWeight: (v: string) => void;
  setReps: (v: string) => void;
}) {
  return (
    <>
      <div className="stepper">
        <label htmlFor={`${prefix}weight`}>Weight (lb)</label>
        <div className="row">
          <button type="button" className="secondary" aria-label="Weight −5" onClick={() => setWeight(step(weight, -5, 0))}>
            −5
          </button>
          <input
            id={`${prefix}weight`}
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
        <label htmlFor={`${prefix}reps`}>Reps</label>
        <div className="row">
          <button type="button" className="secondary" aria-label="Reps −1" onClick={() => setReps(step(reps, -1, 1))}>
            −1
          </button>
          <input
            id={`${prefix}reps`}
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
    </>
  );
}

function WarmupToggle({ warmup, setWarmup }: { warmup: boolean; setWarmup: (v: boolean) => void }) {
  return (
    <div className="row">
      <button type="button" className="secondary toggle" aria-pressed={warmup} onClick={() => setWarmup(!warmup)}>
        {warmup ? 'Warmup' : 'Working'}
      </button>
    </div>
  );
}

/**
 * The edit sheet a Set chip opens: every field, Save, Delete, and moving the Set earlier or later in
 * its Line. The full Note is here.
 */
function SetSheet({
  set,
  number,
  count,
  busy,
  onSave,
  onDelete,
  onMove,
  onCancel,
}: {
  set: SavedSet;
  number: number;
  count: number;
  busy: boolean;
  onSave: (values: SetValues) => void;
  onDelete: () => void;
  onMove: (by: -1 | 1) => void;
  onCancel: () => void;
}) {
  const [weight, setWeight] = useState(set.weight);
  const [reps, setReps] = useState(String(set.reps));
  const [warmup, setWarmup] = useState(set.warmup);
  const [note, setNote] = useState(set.note ?? '');

  return (
    <form
      className="sheet"
      role="dialog"
      aria-label={`Set ${number}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...values(weight, reps, warmup, note), id: set.id });
      }}
    >
      <h4>Set {number}</h4>
      <Steppers prefix="edit-" weight={weight} reps={reps} setWeight={setWeight} setReps={setReps} />
      <WarmupToggle warmup={warmup} setWarmup={setWarmup} />
      <label htmlFor="edit-note">Note</label>
      <input id="edit-note" value={note} autoComplete="off" onChange={(e) => setNote(e.target.value)} />
      <div className="row actions">
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" className="secondary" disabled={busy || number === 1} onClick={() => onMove(-1)}>
          Earlier
        </button>
        <button type="button" className="secondary" disabled={busy || number === count} onClick={() => onMove(1)}>
          Later
        </button>
        <button type="button" className="secondary danger" disabled={busy} onClick={onDelete}>
          Delete
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** + Line: type a name; a live Exercise's name attaches it, a new one creates it. Pickers hide Retired. */
function AddLine({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [picks, setPicks] = useState<Exercise[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    listExercises({ retired: false }).then(
      (list) => current && setPicks(list),
      (e: unknown) => current && setLoadError(messageOf(e)),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <form
      className="add-line"
      onSubmit={(e) => {
        e.preventDefault();
        if (normalised(name)) onAdd(name);
      }}
    >
      <label htmlFor="add-line">Exercise</label>
      <div className="row">
        <input id="add-line" list="add-line-picks" value={name} autoComplete="off" required onChange={(e) => setName(e.target.value)} />
        <datalist id="add-line-picks">
          {picks.map((e) => (
            <option key={e.id} value={e.name} />
          ))}
        </datalist>
        <button type="submit" disabled={busy}>
          Add
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {loadError && <p className="quiet">{loadError}</p>}
    </form>
  );
}

/**
 * Today, logging (spec §5, Focus layout): one Line at a time. A chip strip of the Lines with their
 * Set counts and + Line; the current Line's Exercise, today's Sets as chips (Warmups tinted, a Note as
 * a dot; tapping one opens its edit sheet), Weight (−5 / +5) and Reps (−1 / +1) steppers with editable
 * values, a Warmup toggle, a Note and a large Save Set N; Previous and Next Line, and Remove Line
 * while the Line has no Sets. Delete Session once there is one.
 *
 * After a save Weight and Reps stay as they were, the mark resets to Working and the Note to blank;
 * moving to another Line clears the inputs.
 */
export function Logger({
  logging,
  today,
  busy,
  actions,
}: {
  logging: Logging;
  today: string;
  busy: boolean;
  actions: LoggerActions;
}) {
  const lines = screenLines(logging);
  const [current, setCurrent] = useState(0);
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [warmup, setWarmup] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const index = Math.min(current, Math.max(0, lines.length - 1));
  const line = lines[index];
  const routine = logging.kind === 'draft' ? logging.routine : logging.session.routine;
  const dayName = logging.kind === 'draft' ? logging.day.name : logging.session.day.name;
  const date = logging.kind === 'draft' ? logging.date : logging.session.date;
  const editedSet = line && editing !== null ? line.sets[editing] : undefined;

  function goTo(i: number) {
    setEditing(null);
    if (i === index) return;
    setCurrent(i);
    setWeight('');
    setReps('');
    setWarmup(false);
    setNote('');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (await actions.saveSet(index, values(weight, reps, warmup, note))) {
      setWarmup(false);
      setNote('');
    }
  }

  async function onAdd(name: string) {
    if (await actions.addLine(name)) {
      setAdding(false);
      goTo(lines.length); // the new Line, at the end
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
              onChange={(e) => e.target.value && actions.changeDate(e.target.value)}
            />
            <button type="button" className="secondary" onClick={actions.close}>
              Close
            </button>
          </div>
        ) : (
          <div className="row logger-date">
            <p className="quiet">{date === today ? 'Today' : shownDate(date, today)}</p>
            {date !== today && (
              <button type="button" className="secondary" onClick={actions.close}>
                Back to today
              </button>
            )}
          </div>
        )}
      </header>

      <nav className="chips line-strip" aria-label="Lines">
        {lines.map((l, i) => (
          <button
            key={l.key}
            type="button"
            className="chip"
            aria-current={i === index ? 'true' : undefined}
            onClick={() => goTo(i)}
          >
            {l.name} <span className="count">{l.sets.length}</span>
          </button>
        ))}
        <button type="button" className="chip add" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          + Line
        </button>
      </nav>
      {adding && <AddLine busy={busy} onAdd={(name) => void onAdd(name)} onCancel={() => setAdding(false)} />}

      {!line ? (
        <p className="quiet">{dayName} has no Lines. Add one with + Line.</p>
      ) : (
        <>
          <h3 className="exercise-name">{line.name}</h3>

          {line.sets.length > 0 && (
            <ol className="chips sets" aria-label="Today’s Sets">
              {line.sets.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={s.warmup ? 'chip set warmup' : 'chip set'}
                    aria-expanded={editing === i}
                    onClick={() => setEditing(editing === i ? null : i)}
                  >
                    {s.weight} × {s.reps}
                    {s.warmup && <span className="visually-hidden"> Warmup</span>}
                    {s.note && (
                      <span className="note-dot">
                        <span aria-hidden="true">•</span>
                        <span className="visually-hidden"> Note</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}

          {editedSet && editing !== null && (
            <SetSheet
              key={`${editedSet.id}-${editing}`}
              set={editedSet}
              number={editing + 1}
              count={line.sets.length}
              busy={busy}
              onSave={(v) => void actions.editSet(index, editing, v).then((ok) => ok && setEditing(null))}
              onDelete={() => void actions.editSet(index, editing, null).then((ok) => ok && setEditing(null))}
              onMove={(by) => void actions.moveSet(index, editing, by).then((ok) => ok && setEditing(editing + by))}
              onCancel={() => setEditing(null)}
            />
          )}

          <form className="set-form" onSubmit={(e) => void onSubmit(e)}>
            <Steppers prefix="" weight={weight} reps={reps} setWeight={setWeight} setReps={setReps} />
            <WarmupToggle warmup={warmup} setWarmup={setWarmup} />
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
          {line.sets.length === 0 && (
            <div className="row actions">
              <button
                type="button"
                className="secondary danger"
                disabled={busy}
                onClick={() => void actions.removeLine(index).then((ok) => ok && setEditing(null))}
              >
                Remove Line
              </button>
            </div>
          )}
        </>
      )}

      {logging.kind === 'session' && (
        <div className="session-end">
          {confirmDelete ? (
            <div className="confirm" role="group" aria-label="Delete Session">
              <p>Delete this Session and all its Sets? This can’t be undone.</p>
              <div className="row actions">
                <button type="button" className="danger-solid" disabled={busy} onClick={() => void actions.deleteSession()}>
                  Delete Session
                </button>
                <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="secondary danger" onClick={() => setConfirmDelete(true)}>
              Delete Session…
            </button>
          )}
        </div>
      )}
    </section>
  );
}
