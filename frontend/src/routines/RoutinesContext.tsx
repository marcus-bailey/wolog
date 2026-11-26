import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { messageOf } from '../api';
import { engageRoutine, listRoutines, type Routine } from './api';

interface Routines {
  /** Every Routine by name, or null while loading. */
  routines: Routine[] | null;
  /** Why the Routines couldn't be loaded. */
  loadError: string | null;
  /** Record a Routine the API created or renamed. */
  saved: (routine: Routine) => void;
  /** Switch the Engaged Routine. Rejects with the API's refusal. */
  engage: (id: number) => Promise<void>;
}

const RoutinesContext = createContext<Routines | null>(null);

/**
 * The Routines and which one is engaged, shared by the drawer, the Routines list and Today, so a
 * switch in one shows in all of them.
 */
export function RoutinesProvider({ children }: { children: ReactNode }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listRoutines().then(setRoutines, (e: unknown) => setLoadError(messageOf(e)));
  }, []);

  const saved = useCallback((routine: Routine) => {
    setRoutines((list) => sortByName([...(list ?? []).filter((r) => r.id !== routine.id), routine]));
  }, []);

  const engage = useCallback(async (id: number) => {
    const engaged = await engageRoutine(id);
    setRoutines((list) =>
      sortByName([...(list ?? []).filter((r) => r.id !== id), engaged]).map((r) =>
        r.id === id ? r : { ...r, engaged: false },
      ),
    );
  }, []);

  const value = useMemo(() => ({ routines, loadError, saved, engage }), [routines, loadError, saved, engage]);
  return <RoutinesContext.Provider value={value}>{children}</RoutinesContext.Provider>;
}

export function useRoutines(): Routines {
  const value = useContext(RoutinesContext);
  if (!value) throw new Error('useRoutines needs a RoutinesProvider');
  return value;
}

function sortByName(list: Routine[]): Routine[] {
  return [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
}
