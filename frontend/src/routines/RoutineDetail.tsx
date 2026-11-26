import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { messageOf, Refused } from '../api';
import { listExercises, type Exercise } from '../exercises/api';
import {
  addLine,
  createDay,
  getRoutine,
  removeLine,
  renameDay,
  reorderLines,
  type Day,
  type RoutineDetail as Detail,
} from './api';

/**
 * Routine detail (spec §5): its Days, each expandable to edit its Lines, and Create Day at the
 * bottom. Lines are added by typing an Exercise's name; the picker offers live Exercises only.
 */
export function RoutineDetail() {
  const routineId = Number(useParams().routineId);
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
      <h2>Days</h2>
      {detail.days.length === 0 ? (
        <p className="quiet">No Days yet. Create the first one below.</p>
      ) : (
        <ul className="list" aria-label="Days">
          {detail.days.map((day) => (
            <DayItem key={day.id} day={day} picks={picks} onChanged={dayChanged} onStale={reload} />
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

interface DayProps {
  day: Day;
  picks: Exercise[];
  onChanged: (day: Day) => void;
  /** The Day changed elsewhere: reload the Routine. */
  onStale: () => Promise<void>;
}

function DayItem({ day, picks, onChanged, onStale }: DayProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(day.name);
  const [exerciseName, setExerciseName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof Refused && (e.code === 'lines_changed' || e.code === 'not_found')) await onStale();
    } finally {
      setBusy(false);
    }
  }

  const onRename = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      onChanged(await renameDay(day.id, name));
      setRenaming(false);
    });
  };

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
          <span className="quiet">{count}</span>
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
          {renaming ? (
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
                <button type="button" className="secondary" disabled={busy} onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="row actions">
              <button
                type="button"
                className="secondary"
                aria-label={`Rename ${day.name}`}
                onClick={() => {
                  setName(day.name);
                  setError(null);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="refusal">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
