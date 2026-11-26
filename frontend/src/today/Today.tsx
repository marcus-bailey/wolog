import { Link } from 'react-router';
import { useRoutines } from '../routines/RoutinesContext';

/**
 * Today (spec §5). With no Routine, it points the owner to create one (first run). Days and the
 * rotation don't exist yet, so every Routine's rotation is empty: Today says so (spec §4.7) and
 * offers no Skip.
 */
export function Today() {
  const { routines, loadError } = useRoutines();
  const engaged = routines?.find((r) => r.engaged);

  return (
    <main className="screen">
      <h1>Today</h1>
      {loadError ? (
        <p role="alert" className="refusal">
          {loadError}
        </p>
      ) : routines === null ? (
        <p className="quiet">Loading…</p>
      ) : !engaged ? (
        <div className="card">
          <p>No Routine yet. Create one to start logging.</p>
          <Link className="button" to="/routines">
            Create a Routine
          </Link>
        </div>
      ) : (
        <div className="card">
          <p className="quiet">{engaged.name}</p>
          <p>Nothing is on the rotation.</p>
          <Link className="button" to="/routines">
            Open Routines
          </Link>
        </div>
      )}
    </main>
  );
}
