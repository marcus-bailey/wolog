import { Link } from 'react-router';
import { useRoutines } from '../routines/RoutinesContext';

/**
 * Today (spec §5). With no Routine, it points the owner to create one (first run). The suggestion
 * isn't built yet, so for now Today says nothing is on the rotation (spec §4.7), offers no Skip,
 * and links to the Routine editor.
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
          <Link className="button" to={`/routines/${engaged.id}`}>
            Open {engaged.name}
          </Link>
        </div>
      )}
    </main>
  );
}
