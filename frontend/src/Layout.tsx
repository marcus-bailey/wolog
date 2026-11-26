import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { messageOf } from './api';
import { useRoutines } from './routines/RoutinesContext';
import { SIGN_OUT_URL } from './session';

/**
 * App navigation (spec §5): a ☰ drawer with Today, History, Routines and Sign out, and under
 * "Engaged Routine" every Routine, the engaged one marked ●. Tapping another Routine switches to it.
 */
export function Layout() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <header className="bar">
        <button
          type="button"
          className="menu"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="drawer"
          onClick={() => setOpen(!open)}
        >
          ☰
        </button>
        <span className="brand">Wolog</span>
      </header>
      {open && (
        <>
          <div className="scrim" onClick={close} />
          <nav id="drawer" className="drawer" aria-label="Menu" onKeyDown={(e) => e.key === 'Escape' && close()}>
            <ul className="nav-links">
              <li>
                <NavLink to="/" end onClick={close}>
                  Today
                </NavLink>
              </li>
              <li>
                <NavLink to="/history" onClick={close}>
                  History
                </NavLink>
              </li>
              <li>
                <NavLink to="/routines" onClick={close}>
                  Routines
                </NavLink>
              </li>
              <li>
                <NavLink to="/exercises" onClick={close}>
                  Exercises
                </NavLink>
              </li>
            </ul>
            <EngagedRoutineSwitch onSwitched={close} />
            <a className="sign-out" href={SIGN_OUT_URL}>
              Sign out
            </a>
          </nav>
        </>
      )}
      <Outlet />
    </>
  );
}

function EngagedRoutineSwitch({ onSwitched }: { onSwitched: () => void }) {
  const { routines, engage } = useRoutines();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!routines || routines.length === 0) return null;

  async function onPick(id: number, engaged: boolean) {
    if (engaged) return onSwitched();
    setBusy(true);
    setError(null);
    try {
      await engage(id);
      onSwitched();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="engaged-heading">
      <h2 id="engaged-heading">Engaged Routine</h2>
      <ul className="engaged-switch" aria-labelledby="engaged-heading">
        {routines.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="switch"
              aria-pressed={r.engaged}
              disabled={busy}
              onClick={() => void onPick(r.id, r.engaged)}
            >
              <span className="mark" aria-hidden="true">
                {r.engaged ? '●' : ''}
              </span>
              {r.name}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="refusal">
          {error}
        </p>
      )}
    </section>
  );
}
