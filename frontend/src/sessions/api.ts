import { request } from '../api';
import { localToday } from '../dates';
import { isExercise, type Exercise } from '../exercises/api';

/** A Set as the screen has it: `id` names a saved Set; a new one has none. Weight is lb, as typed. */
export interface SetValues {
  id?: number;
  reps: number;
  weight: string;
  warmup: boolean;
  note: string | null;
}

export interface SavedSet extends SetValues {
  id: number;
}

export interface SessionLine {
  id: number;
  exercise: Exercise;
  sets: SavedSet[];
}

/** A dated record of work on a Day of one Routine. `turn_id` is null when it holds no Turn. */
export interface Session {
  id: number;
  date: string;
  routine: { id: number; name: string };
  day: { id: number; name: string };
  turn_id: number | null;
  lines: SessionLine[];
}

/** A Line of a new Session: one of the Day's Lines (the Snapshot), or an extra Exercise. */
export type NewLine = ({ day_line_id: number } | { exercise_id: number }) & { sets: SetValues[] };

/** A Line of a saved Session, by id, or a new one by Exercise. */
export type LineWrite = ({ id: number } | { exercise_id: number }) & { sets: SetValues[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isNamed(v: unknown): v is { id: number; name: string } {
  return isObject(v) && typeof v.id === 'number' && typeof v.name === 'string';
}

function isSet(v: unknown): v is SavedSet {
  return (
    isObject(v) &&
    typeof v.id === 'number' &&
    typeof v.reps === 'number' &&
    typeof v.weight === 'string' &&
    typeof v.warmup === 'boolean' &&
    (v.note === null || typeof v.note === 'string')
  );
}

function isLine(v: unknown): v is SessionLine {
  return isObject(v) && typeof v.id === 'number' && isExercise(v.exercise) && Array.isArray(v.sets) && v.sets.every(isSet);
}

function expectSession(v: unknown): Session {
  if (
    isObject(v) &&
    typeof v.id === 'number' &&
    typeof v.date === 'string' &&
    isNamed(v.routine) &&
    isNamed(v.day) &&
    (v.turn_id === null || typeof v.turn_id === 'number') &&
    Array.isArray(v.lines) &&
    v.lines.every(isLine)
  ) {
    return {
      id: v.id,
      date: v.date,
      routine: { id: v.routine.id, name: v.routine.name },
      day: { id: v.day.id, name: v.day.name },
      turn_id: v.turn_id,
      lines: v.lines,
    };
  }
  throw new Error('Unexpected answer from the API.');
}

/** The Session on this civil date, whatever its Routine, or null. */
export async function getSessionOn(date: string): Promise<Session | null> {
  const body = await request('GET', `sessions/on/${date}`);
  return body === null ? null : expectSession(body);
}

/**
 * Save the first Set: creates the Session on `date` from the Snapshot of the suggested Day. Refused
 * if the Engaged Routine, the suggestion or the Day's Lines changed since the logger opened
 * (`routine_switched`, `suggestion_changed`, `day_changed`), or the date already has a Session
 * (`session_exists`).
 */
export async function createSession(body: {
  date: string;
  routineId: number;
  turnId: number;
  dayLines: number[];
  lines: NewLine[];
}): Promise<Session> {
  return expectSession(
    await request('POST', 'sessions', {
      date: body.date,
      today: localToday(),
      routine_id: body.routineId,
      turn_id: body.turnId,
      day_lines: body.dayLines,
      lines: body.lines,
    }),
  );
}

/** Make the Session's Lines and Sets these. Null means no Set was left, so the Session is gone. */
export async function writeSession(id: number, lines: LineWrite[]): Promise<Session | null> {
  const body = await request('PUT', `sessions/${id}`, { lines });
  return body === null ? null : expectSession(body);
}
