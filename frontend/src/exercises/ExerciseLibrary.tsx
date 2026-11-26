import { useEffect, useState, type FormEvent } from 'react';
import { messageOf } from '../api';
import {
  createExercise,
  deleteExercise,
  listExercises,
  renameExercise,
  setRetired,
  type Exercise,
} from './api';

/**
 * The Exercise library (spec §4.1, §5): list, create, rename, Retire / Un-retire, and delete
 * if unused. Retired Exercises are listed in their own section.
 */
export function ExerciseLibrary() {
  const [exercises, setExercises] = useState<Exercise[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listExercises().then(setExercises, (e: unknown) => setError(messageOf(e)));
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await createExercise(name);
      setExercises((list) => sortByName([...(list ?? []), created]));
      setName('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  function replaced(changed: Exercise) {
    setExercises((list) => sortByName((list ?? []).map((e) => (e.id === changed.id ? changed : e))));
  }

  function removed(id: number) {
    setExercises((list) => (list ?? []).filter((e) => e.id !== id));
  }

  const live = exercises?.filter((e) => !e.retired) ?? [];
  const retired = exercises?.filter((e) => e.retired) ?? [];

  return (
    <main className="screen">
      <h1>Exercises</h1>
      <form className="create" onSubmit={onCreate}>
        <label htmlFor="new-exercise">New Exercise</label>
        <div className="row">
          <input
            id="new-exercise"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            placeholder="e.g. Bench Press"
          />
          <button type="submit" disabled={saving}>
            Create
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="refusal">
          {error}
        </p>
      )}
      {exercises === null ? (
        !error && <p className="quiet">Loading…</p>
      ) : exercises.length === 0 ? (
        <p className="quiet">No Exercises yet. Create the first one above.</p>
      ) : (
        <>
          {live.length === 0 ? (
            <p className="quiet">Every Exercise is Retired.</p>
          ) : (
            <ExerciseList label="Exercises" exercises={live} onChanged={replaced} onDeleted={removed} />
          )}
          {retired.length > 0 && (
            <section aria-labelledby="retired-heading">
              <h2 id="retired-heading">Retired</h2>
              <p className="quiet">Hidden from pickers. Their Lines and history stay.</p>
              <ExerciseList label="Retired Exercises" exercises={retired} onChanged={replaced} onDeleted={removed} />
            </section>
          )}
        </>
      )}
    </main>
  );
}

interface ListProps {
  label: string;
  exercises: Exercise[];
  onChanged: (e: Exercise) => void;
  onDeleted: (id: number) => void;
}

function ExerciseList({ label, exercises, onChanged, onDeleted }: ListProps) {
  return (
    <ul className="list" aria-label={label}>
      {exercises.map((e) => (
        <ExerciseRow key={e.id} exercise={e} onChanged={onChanged} onDeleted={onDeleted} />
      ))}
    </ul>
  );
}

interface RowProps {
  exercise: Exercise;
  onChanged: (e: Exercise) => void;
  onDeleted: (id: number) => void;
}

function ExerciseRow({ exercise, onChanged, onDeleted }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(exercise.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setEditing(false);
    setConfirmingDelete(false);
    setError(null);
  }

  const onRename = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      onChanged(await renameExercise(exercise.id, name));
      close();
    });
  };
  const onRetire = () =>
    act(async () => {
      onChanged(await setRetired(exercise.id, !exercise.retired));
      close();
    });
  const onDelete = () =>
    act(async () => {
      try {
        await deleteExercise(exercise.id);
      } finally {
        setConfirmingDelete(false);
      }
      onDeleted(exercise.id);
    });

  if (!editing) {
    return (
      <li className="exercise">
        <span className="name">{exercise.name}</span>
        <button
          type="button"
          className="secondary"
          aria-label={`Edit ${exercise.name}`}
          onClick={() => {
            setName(exercise.name);
            setEditing(true);
          }}
        >
          Edit
        </button>
      </li>
    );
  }

  const inputId = `exercise-${exercise.id}-name`;
  return (
    <li className="exercise editing">
      <form onSubmit={onRename}>
        <label htmlFor={inputId}>Name</label>
        <div className="row">
          <input id={inputId} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
          <button type="submit" disabled={busy}>
            Rename
          </button>
        </div>
        <div className="row actions">
          <button type="button" className="secondary" disabled={busy} onClick={onRetire}>
            {exercise.retired ? 'Un-retire' : 'Retire'}
          </button>
          <button
            type="button"
            className="secondary danger"
            disabled={busy || confirmingDelete}
            onClick={() => {
              setError(null);
              setConfirmingDelete(true);
            }}
          >
            Delete
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
      {confirmingDelete && (
        <div className="confirm" role="group" aria-label="Confirm delete">
          <p>
            Delete “{exercise.name}” for good? This can’t be undone. Only an Exercise that is on no Line can be
            deleted.
          </p>
          <div className="row actions">
            <button type="button" className="danger-solid" disabled={busy} onClick={onDelete}>
              Delete for good
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmingDelete(false)}>
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
    </li>
  );
}

function sortByName(list: Exercise[]): Exercise[] {
  return [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
}
