import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router';
import { ExerciseLibrary } from './exercises/ExerciseLibrary';
import { History } from './history/History';
import { Layout } from './Layout';
import { RoutineDetail } from './routines/RoutineDetail';
import { RoutineList } from './routines/RoutineList';
import { RoutinesProvider } from './routines/RoutinesContext';
import { localToday } from './dates';
import { Today } from './today/Today';

/** Client routes sit under the app's base path (/wolog/ in production). */
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

export function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <AppRoutes />
    </BrowserRouter>
  );
}

/** A real calendar date written YYYY-MM-DD (not, say, 2024-02-30). */
function isCivilDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  return localToday(new Date(y, m - 1, d)) === text;
}

/**
 * Today, or the Session on `?on=YYYY-MM-DD` opened from History. A new date (or none) is a fresh
 * screen, so the drawer's Today always comes back to today.
 */
function TodayScreen() {
  const [params] = useSearchParams();
  const on = params.get('on');
  const valid = on !== null && isCivilDate(on) ? on : undefined;
  return <Today key={valid ?? ''} on={valid} />;
}

/** The screens, inside the app's navigation. Tests render this in a MemoryRouter. */
export function AppRoutes() {
  return (
    <RoutinesProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<TodayScreen />} />
          <Route path="history" element={<History />} />
          <Route path="routines" element={<RoutineList />} />
          <Route path="routines/:routineId" element={<RoutineDetail />} />
          <Route path="exercises" element={<ExerciseLibrary />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </RoutinesProvider>
  );
}
