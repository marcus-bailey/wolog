import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { messageOf, Refused } from '../api';
import { listExercises, type Exercise } from '../exercises/api';
import {
  addLine,
  addTurn,
  createDay,
  destroyDay,
  destroyRoutine,
  dropDay,
  duplicateDay,
  duplicateRoutine,
  getRoutine,
  putBackDay,
  removeLine,
  removeTurn,
  renameDay,
  reorderLines,
  reorderTurns,
  type Day,
  type Routine,
  type RoutineDetail as Detail,
} from './api';
import { useRoutines } from './RoutinesContext';

/**
 * Routine detail (spec §5): Duplicate and Destroy for the Routine, the rotation as numbered Turns
 * with the next one marked, then the Days, each expandable to edit its Lines, to Drop it from or Put
 * it back on the rotation, to Duplicate it to a Routine and to Destroy it, and Create Day at the
 * bottom. Lines are added by typing an Exercise's name; the picker offers live Exercises only.
 */
export function RoutineDetail() {
  const routineId = useParams().routineId;
  // A fresh screen per Routine, so opening a duplicate starts from its own state.
  return <RoutineScreen key={routineId} routineId={Number(routineId)} />;
}

function RoutineScreen({ routineId }: { routineId: number }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Exercise[]>([]);

  const reload = useCallback(
    () => getRoutine(routineId).then(setDetail, (e: unknown) => setLoadError(messageOf(e))),
    [routineId],
  );

  useEffect(() => {
    void reload();
    listExercises({ retired: false }).then(setPicks, () => setPicks([]));
  }, [reload]);

  function dayChanged(day: Day) {
    setDetail((d) => d && { ...d, days: d.days.map((x) => (x.id === day.id ? day : x)) });
    // A name typed on a Line may have created an Exercise: offer it from now on.
    setPicks((list) => {
      const known = new Set(list.map((e) => e.id));
      const added = day.lines.map((l) => l.exercise).filter((e) => !e.retired && !known.has(e.id));
      return added.length ? [...list, ...added] : list;
    });
  }

  if (loadError) {
    return (
      <main className="screen">
        <p role="alert" className="refusal">
          {loadError}
        </p>
        <Link to="/routines">All Routines</Link>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="screen">
        <p className="quiet">Loading…</p>
      </main>
    );
  }

  return (
    <main className="screen">
      <p>
        <Link to="/routines">← Routines</Link>
      </p>
      <h1>
        {detail.name}
        {detail.engaged && <span className="engaged"> ● Engaged</span>}
      </h1>
      <RoutineActions routine={detail} />
      <RotationEditor detail={detail} onChanged={setDetail} onStale={reload} />
      <h2>Days</h2>
      {detail.days.length === 0 ? (
        <p className="quiet">No Days yet. Create the first one below.</p>
      ) : (
        <ul className="list" aria-label="Days">
          {detail.days.map((day) => (
            <DayItem
              key={day.id}
              day={day}
              routine={detail}
              onRotation={detail.rotation.some((t) => t.day_id === day.id)}
              picks={picks}
              onChanged={dayChanged}
              onRotationChanged={setDetail}
              onStale={reload}
            />
          ))}
        </ul>
      )}
      <CreateDay routineId={detail.id} onCreated={reload} />
      <datalist id="exercise-picks">
        {[...picks]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (
            <option key={e.id} value={e.name} />
          ))}
      </datalist>
    </main>
  );
}

/** Duplicate the Routine under a new name (then open the copy), or Destroy it after confirming. */
function RoutineActions({ routine }: { routine: Routine }) {
  const { saved, removed } = useRoutines();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'duplicate' | 'destroy' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
      if (mode === 'destroy') setMode(null);
    } finally {
      setBusy(false);
    }
  }

  const onDuplicate = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const copy = await duplicateRoutine(routine.id, name);
      saved({ id: copy.id, name: copy.name, engaged: copy.engaged });
      void navigate(`/routines/${copy.id}`);
    });
  };

  const onDestroy = () =>
    act(async () => {
      try {
        await destroyRoutine(routine.id);
      } catch (e) {
        // Destroyed elsewhere already: the outcome asked for.
        if (!(e instanceof Refused && e.code === 'not_found')) throw e;
      }
      removed(routine.id);
      void navigate('/routines');
    });

  return (
    <section aria-label="Routine actions">
      {mode === 'duplicate' ? (
        <form onSubmit={onDuplicate}>
          <label htmlFor="duplicate-routine">Name of the new Routine</label>
          <div className="row">
            <input
              id="duplicate-routine"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" disabled={busy}>
              Duplicate
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setMode(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="quiet">Copies every Day with its Lines, and the rotation. No Sessions or Skips.</p>
        </form>
      ) : (
        <div className="row actions">
          <button
            type="button"
            className="secondary"
            aria-label={`Duplicate ${routine.name}`}
            disabled={busy}
            onClick={() => {
              setName(`${routine.name} copy`);
              setError(null);
              setMode('duplicate');
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="secondary danger"
            aria-label={`Destroy ${routine.name}`}
            disabled={busy || mode === 'destroy'}
            onClick={() => {
              setError(null);
              setMode('destroy');
            }}
          >
            Destroy
          </button>
        </div>
      )}
      {mode === 'destroy' && (
        <div className="confirm" role="group" aria-label={`Destroy ${routine.name}`}>
          <p>
            Destroy “{routine.name}” for good? Its Days, Lines and rotation go with it; its Exercises stay in the
            library. This can’t be undone.
          </p>
          <div className="row actions">
            <button type="button" className="danger-solid" disabled={busy} onClick={() => void onDestroy()}>
              Destroy for good
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setMode(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="refusal">
          {error}
        </p>
      )}
    </section>
  );
}

function CreateDay({ routineId, onCreated }: { routineId: number; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createDay(routineId, name);
      setName('');
      await onCreated();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="create" onSubmit={onSubmit}>
      <label htmlFor="new-day">New Day</label>
      <div className="row">
        <input
          id="new-day"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          placeholder="e.g. Push"
        />
        <button type="submit" disabled={saving}>
          Create Day
        </button>
      </div>
      {error && (
        <p role="alert" className="refusal">
          {error}
        </p>
      )}
    </form>
  );
}

interface RotationProps {
  detail: Detail;
  onChanged: (detail: Detail) => void;
  /** The rotation changed elsewhere: reload the Routine. */
  onStale: () => Promise<void>;
}

/** The rotation (spec §4.3): numbered Turns with ↑ / ↓ / ✕, and "Add a Turn for…" a Day. */
function RotationEditor({ detail, onChanged, onStale }: RotationProps) {
  const [dayId, setDayId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dayName = new Map(detail.days.map((d) => [d.id, d.name]));
  const turns = detail.rotation;

  async function act(action: () => Promise<Detail>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof Refused && (e.code === 'rotation_changed' || e.code === 'not_found')) await onStale();
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    const ids = turns.map((t) => t.id);
    ids.splice(index + by, 0, ...ids.splice(index, 1));
    void act(() => reorderTurns(detail.id, ids));
  }

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!dayId) return;
    void act(() => addTurn(detail.id, Number(dayId)));
  };

  return (
    <section aria-labelledby="rotation-heading">
      <h2 id="rotation-heading">Rotation</h2>
      {turns.length === 0 ? (
        <p className="quiet">
          Nothing is on the rotation.{detail.days.length > 0 ? ' Add a Turn for a Day below.' : ''}
        </p>
      ) : (
        <ol className="lines turns" aria-label="Rotation">
          {turns.map((turn, i) => {
            const label = `Turn ${i + 1}, ${dayName.get(turn.day_id) ?? ''}`;
            return (
              <li key={turn.id} className="line">
                <span className="position">{i + 1}</span>
                <span className="name">
                  {dayName.get(turn.day_id)}
                  {turn.id === detail.next_turn_id && <span className="next"> · next</span>}
                </span>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Move ${label} up`}
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Move ${label} down`}
                  disabled={busy || i === turns.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon danger"
                  aria-label={`Remove ${label}`}
                  disabled={busy}
                  onClick={() => void act(() => removeTurn(detail.id, turn.id))}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {detail.days.length > 0 && (
        <form onSubmit={onAdd}>
          <label htmlFor="add-turn">Add a Turn for…</label>
          <div className="row">
            <select id="add-turn" value={dayId} onChange={(e) => setDayId(e.target.value)}>
              <option value="">Choose a Day</option>
              {detail.days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy || !dayId}>
              Add Turn
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="refusal">
          {error}
        </p>
      )}
    </section>
  );
}

interface DayProps {
  day: Day;
  /** The Routine the Day belongs to. */
  routine: Routine;
  /** Whether the Day has at least one Turn. */
  onRotation: boolean;
  picks: Exercise[];
  onChanged: (day: Day) => void;
  onRotationChanged: (detail: Detail) => void;
  /** The Day changed elsewhere: reload the Routine. */
  onStale: () => Promise<void>;
}

function DayItem({ day, routine, onRotation, picks, onChanged, onRotationChanged, onStale }: DayProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'rename' | 'duplicate' | 'destroy' | null>(null);
  const [name, setName] = useState(day.name);
  const [exerciseName, setExerciseName] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The refusal was that something pins the Day: offer Drop instead. */
  const [offerDrop, setOfferDrop] = useState(false);
  /** Where the last copy into another Routine went. */
  const [copied, setCopied] = useState<{ routine: Routine; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setOfferDrop(false);
    setCopied(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
      if (mode === 'destroy') setMode(null);
      if (e instanceof Refused && e.code === 'day_pinned') setOfferDrop(true);
      if (e instanceof Refused && ['lines_changed', 'not_found', 'day_on_rotation'].includes(e.code)) await onStale();
    } finally {
      setBusy(false);
    }
  }

  const drop = () => void act(async () => onRotationChanged(await dropDay(day.id)));

  const onRename = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      onChanged(await renameDay(day.id, name));
      setMode(null);
    });
  };

  const onDuplicate = (target: number, copyName: string) =>
    act(async () => {
      const into = await duplicateDay(day.id, target, copyName);
      setMode(null);
      if (into.id === routine.id) onRotationChanged(into);
      else setCopied({ routine: into, name: into.days.at(-1)?.name ?? copyName });
    });

  const onDestroy = () =>
    act(async () => {
      const detail = await destroyDay(day.id);
      setMode(null);
      onRotationChanged(detail); // the Day is gone from it
    });

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      onChanged(await addLine(day.id, exerciseName));
      setExerciseName('');
    });
  };

  function move(index: number, by: -1 | 1) {
    const ids = day.lines.map((l) => l.id);
    ids.splice(index + by, 0, ...ids.splice(index, 1));
    void act(async () => onChanged(await reorderLines(day.id, ids)));
  }

  const count = day.lines.length === 1 ? '1 Line' : `${day.lines.length} Lines`;

  return (
    <li className="day">
      <div className="row">
        <button
          type="button"
          className="day-toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
        >
          <span className="name">{day.name}</span>
          <span className="quiet">
            {count}
            {!onRotation && ' · off the rotation'}
          </span>
        </button>
      </div>
      {open && (
        <div id={`${id}-body`} className="day-body">
          {day.lines.length === 0 ? (
            <p className="quiet">No Lines yet.</p>
          ) : (
            <ol className="lines" aria-label={`Lines of ${day.name}`}>
              {day.lines.map((line, i) => {
                const label = `${line.exercise.name} (Line ${i + 1})`;
                return (
                  <li key={line.id} className="line">
                    <span className="name">
                      {line.exercise.name}
                      {line.exercise.retired && <span className="quiet"> · Retired</span>}
                    </span>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Move ${label} up`}
                      disabled={busy || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Move ${label} down`}
                      disabled={busy || i === day.lines.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon danger"
                      aria-label={`Remove ${label}`}
                      disabled={busy}
                      onClick={() => void act(async () => onChanged(await removeLine(day.id, line.id)))}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <form onSubmit={onAdd}>
            <label htmlFor={`${id}-add`}>Add an Exercise</label>
            <div className="row">
              <input
                id={`${id}-add`}
                list="exercise-picks"
                value={exerciseName}
                onChange={(e) => setExerciseName(e.target.value)}
                autoComplete="off"
                placeholder={picks.length ? 'Pick or type a new name' : 'Type a name'}
              />
              <button type="submit" disabled={busy}>
                Add
              </button>
            </div>
          </form>
          {mode === 'rename' ? (
            <form onSubmit={onRename}>
              <label htmlFor={`${id}-name`}>Day name</label>
              <div className="row">
                <input
                  id={`${id}-name`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
                <button type="submit" disabled={busy}>
                  Rename
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setMode(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : mode === 'duplicate' ? (
            <DuplicateDay
              day={day}
              routine={routine}
              busy={busy}
              onDuplicate={(target, copyName) => void onDuplicate(target, copyName)}
              onCancel={() => {
                setMode(null);
                setError(null);
              }}
            />
          ) : (
            <div className="row actions">
              {onRotation ? (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Drop ${day.name} from the rotation`}
                  disabled={busy}
                  onClick={drop}
                >
                  Drop from rotation
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Put ${day.name} back on the rotation`}
                  disabled={busy}
                  onClick={() => void act(async () => onRotationChanged(await putBackDay(day.id)))}
                >
                  Put back
                </button>
              )}
              <button
                type="button"
                className="secondary"
                aria-label={`Rename ${day.name}`}
                onClick={() => {
                  setName(day.name);
                  setError(null);
                  setMode('rename');
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={`Duplicate ${day.name} to…`}
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setCopied(null);
                  setMode('duplicate');
                }}
              >
                Duplicate to…
              </button>
              <button
                type="button"
                className="secondary danger"
                aria-label={`Destroy ${day.name}`}
                disabled={busy || mode === 'destroy'}
                onClick={() => {
                  setError(null);
                  setOfferDrop(false);
                  setMode('destroy');
                }}
              >
                Destroy
              </button>
            </div>
          )}
          {mode === 'destroy' && (
            <div className="confirm" role="group" aria-label={`Destroy ${day.name}`}>
              <p>
                Destroy “{day.name}” for good? Its Lines and Turns go with it; its Exercises stay in the library. This
                can’t be undone.
              </p>
              <div className="row actions">
                <button type="button" className="danger-solid" disabled={busy} onClick={() => void onDestroy()}>
                  Destroy for good
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setMode(null)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
          {copied && (
            <p role="status">
              Copied to <Link to={`/routines/${copied.routine.id}`}>{copied.routine.name}</Link> as “{copied.name}”.
            </p>
          )}
          {error && (
            <div role="alert" className="refusal">
              <p>{error}</p>
              {offerDrop && onRotation && (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Drop ${day.name} from the rotation instead`}
                  disabled={busy}
                  onClick={drop}
                >
                  Drop from rotation instead
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

interface DuplicateDayProps {
  day: Day;
  routine: Routine;
  busy: boolean;
  onDuplicate: (routineId: number, name: string) => void;
  onCancel: () => void;
}

/**
 * "Duplicate to…" a Routine: this one or another. The copy needs a name unique there, so into this
 * Routine it starts as "‹Day› copy", and into another as the Day's own name.
 */
function DuplicateDay({ day, routine, busy, onDuplicate, onCancel }: DuplicateDayProps) {
  const id = useId();
  const { routines } = useRoutines();
  const nameFor = (target: number) => (target === routine.id ? `${day.name} copy` : day.name);
  const [target, setTarget] = useState(routine.id);
  const [name, setName] = useState(nameFor(routine.id));
  const targets = routines?.some((r) => r.id === routine.id) ? routines : [routine, ...(routines ?? [])];

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    onDuplicate(target, name);
  };

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor={`${id}-target`}>Into Routine</label>
      <select
        id={`${id}-target`}
        value={target}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (name === nameFor(target)) setName(nameFor(next)); // keep a name the owner typed
          setTarget(next);
        }}
      >
        {targets.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-copy`}>Name of the copy</label>
      <div className="row">
        <input id={`${id}-copy`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <button type="submit" disabled={busy}>
          Duplicate
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
