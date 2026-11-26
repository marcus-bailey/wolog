import { useEffect, useState, type FormEvent } from 'react';
import { createExercise, listExercises, type Exercise } from './api';

/** The Exercise library (spec §4.1, §5): list Exercises and create one by name. */
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
        <ul className="list" aria-label="Exercises">
          {exercises.map((e) => (
            <li key={e.id}>{e.name}</li>
          ))}
        </ul>
      )}
    </main>
  );
}

function sortByName(list: Exercise[]): Exercise[] {
  return [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.';
}
