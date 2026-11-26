import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ExerciseLibrary } from './exercises/ExerciseLibrary';
import { History } from './history/History';
import { Layout } from './Layout';
import { RoutineDetail } from './routines/RoutineDetail';
import { RoutineList } from './routines/RoutineList';
import { RoutinesProvider } from './routines/RoutinesContext';
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

/** The screens, inside the app's navigation. Tests render this in a MemoryRouter. */
export function AppRoutes() {
  return (
    <RoutinesProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Today />} />
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
