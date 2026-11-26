import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { messageOf } from '../api';
import { createRoutine, renameRoutine, type Routine } from './api';
import { useRoutines } from './RoutinesContext';

/**
 * The Routines list (spec §4.2, §5): each Routine with the engaged one marked, Engage on each
 * other one, rename, and Create. A new Routine has just a name; the first one is engaged.
 */
export function RoutineList() {
  const { routines, loadError, saved } = useRoutines();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      saved(await createRoutine(name));
      setName('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="screen">
      <h1>Routines</h1>
      <form className="create" onSubmit={onCreate}>
        <label htmlFor="new-routine">New Routine</label>
        <div className="row">
          <input
            id="new-routine"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            placeholder="e.g. Push Pull Legs"
          />
          <button type="submit" disabled={saving}>
            Create
          </button>
        </div>
      </form>
      {(error ?? loadError) && (
        <p role="alert" className="refusal">
          {error ?? loadError}
        </p>
      )}
      {routines === null ? (
        !loadError && <p className="quiet">Loading…</p>
      ) : routines.length === 0 ? (
        <p className="quiet">No Routines yet. Create the first one above; it becomes the Engaged Routine.</p>
      ) : (
        <ul className="list" aria-label="Routines">
          {routines.map((r) => (
            <RoutineRow key={r.id} routine={r} />
          ))}
        </ul>
      )}
      <p>
        <Link to="/exercises">Exercise library</Link>
      </p>
    </main>
  );
}

function RoutineRow({ routine }: { routine: Routine }) {
  const { saved, engage } = useRoutines();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(routine.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const onRename = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      saved(await renameRoutine(routine.id, name));
      setEditing(false);
    });
  };

  if (editing) {
    const inputId = `routine-${routine.id}-name`;
    return (
      <li className="routine editing">
        <form onSubmit={onRename}>
          <label htmlFor={inputId}>Name</label>
          <div className="row">
            <input id={inputId} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
            <button type="submit" disabled={busy}>
              Rename
            </button>
          </div>
          <div className="row actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
        {error && (
          <p role="alert" className="refusal">
            {error}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className="routine">
      <div className="row">
        <span className="name">
          <Link to={`/routines/${routine.id}`}>{routine.name}</Link>
          {routine.engaged && <span className="engaged"> ● Engaged</span>}
        </span>
        {!routine.engaged && (
          <button
            type="button"
            aria-label={`Engage ${routine.name}`}
            disabled={busy}
            onClick={() => void act(() => engage(routine.id))}
          >
            Engage
          </button>
        )}
        <button
          type="button"
          className="secondary"
          aria-label={`Rename ${routine.name}`}
          disabled={busy}
          onClick={() => {
            setName(routine.name);
            setError(null);
            setEditing(true);
          }}
        >
          Rename
        </button>
      </div>
      {error && (
        <p role="alert" className="refusal">
          {error}
        </p>
      )}
    </li>
  );
}
