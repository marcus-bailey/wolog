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
  /** Bumped by every write; a write from an older one is refused (`session_changed`). */
  version: number;
  lines: SessionLine[];
}

/**
 * A Line of a new Session: one of the Day's Lines (the Snapshot), or an extra Exercise by id or by
 * the name typed (a live Exercise's name attaches it; a new name creates it).
 */
export type NewLine = ({ day_line_id: number } | { exercise_id: number } | { name: string }) & { sets: SetValues[] };

/** A Line of a saved Session, by id, or a new one (appended) by Exercise id or name. */
export type LineWrite = ({ id: number } | { exercise_id: number } | { name: string }) & { sets: SetValues[] };

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
    typeof v.version === 'number' &&
    Array.isArray(v.lines) &&
    v.lines.every(isLine)
  ) {
    return {
      id: v.id,
      date: v.date,
      routine: { id: v.routine.id, name: v.routine.name },
      day: { id: v.day.id, name: v.day.name },
      turn_id: v.turn_id,
      version: v.version,
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
  /** The Day picked instead of the suggested one (Pick another Day), if any. */
  dayId?: number;
  dayLines: number[];
  lines: NewLine[];
}): Promise<Session> {
  return expectSession(
    await request('POST', 'sessions', {
      date: body.date,
      today: localToday(),
      routine_id: body.routineId,
      turn_id: body.turnId,
      ...(body.dayId === undefined ? {} : { day_id: body.dayId }),
      day_lines: body.dayLines,
      lines: body.lines,
    }),
  );
}

/**
 * Make the Session's Lines and Sets these, from the version the screen shows. Null means no Set was
 * left, so the Session is gone. Refused if it changed meanwhile (`session_changed`), a Set moved
 * Lines (`set_moved`), a removed Line has Sets (`line_has_sets`), or a new Line names a Retired
 * Exercise (`name_retired`). `dayId` changes the Session's Day (Change-Day): a relabel, re-pinning
 * its Turn; Lines and Sets are as given.
 */
export async function writeSession(session: Session, lines: LineWrite[], dayId?: number): Promise<Session | null> {
  const body = await request('PUT', `sessions/${session.id}`, {
    version: session.version,
    ...(dayId === undefined ? {} : { day_id: dayId }),
    lines,
  });
  return body === null ? null : expectSession(body);
}

/** Delete the Session with its Lines and Sets. Skips it replaced are not restored. */
export async function deleteSession(id: number): Promise<void> {
  await request('DELETE', `sessions/${id}`);
}
