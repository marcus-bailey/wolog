import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ExerciseLibrary } from './exercises/ExerciseLibrary';

/** Client routes sit under the app's base path (/wolog/ in production). */
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

export function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <Routes>
        <Route path="/exercises" element={<ExerciseLibrary />} />
        <Route path="*" element={<Navigate to="/exercises" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
