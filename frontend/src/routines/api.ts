import { request } from '../api';
import { isExercise, type Exercise } from '../exercises/api';

export interface Routine {
  id: number;
  name: string;
  /** Once any Routine exists, exactly one is engaged: new Sessions and Skips go to it. */
  engaged: boolean;
}

function isRoutine(value: unknown): value is Routine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && typeof v.name === 'string' && typeof v.engaged === 'boolean';
}

function expectRoutine(value: unknown): Routine {
  if (!isRoutine(value)) throw new Error('Unexpected answer from the API.');
  return value;
}

/** Every Routine by name. Empty means first run. */
export async function listRoutines(): Promise<Routine[]> {
  const body = await request('GET', 'routines');
  if (!Array.isArray(body)) throw new Error('Unexpected answer from the API.');
  return body.map(expectRoutine);
}

/** The first Routine created is engaged; later ones are not. */
export async function createRoutine(name: string): Promise<Routine> {
  return expectRoutine(await request('POST', 'routines', { name }));
}

export async function renameRoutine(id: number, name: string): Promise<Routine> {
  return expectRoutine(await request('PATCH', `routines/${id}`, { name }));
}

/** Switch the Engaged Routine to this one. There is no disengage. */
export async function engageRoutine(id: number): Promise<Routine> {
  return expectRoutine(await request('POST', `routines/${id}/engage`));
}

/** An ordered appearance of an Exercise on a Day. Its Exercise may since have been Retired. */
export interface Line {
  id: number;
  exercise: Exercise;
}

export interface Day {
  id: number;
  name: string;
  lines: Line[];
}

/** One place in the rotation, naming a Day. */
export interface Turn {
  id: number;
  day_id: number;
}

export interface RoutineDetail extends Routine {
  /** In the order they were created. */
  days: Day[];
  rotation: Turn[];
  /** The Turn the suggestion is on (the next one to log), or null with an empty rotation. */
  next_turn_id: number | null;
}

function isLine(value: unknown): value is Line {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && isExercise(v.exercise);
}

export function expectDay(value: unknown): Day {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v.id === 'number' && typeof v.name === 'string' && Array.isArray(v.lines) && v.lines.every(isLine)) {
      return { id: v.id, name: v.name, lines: v.lines };
    }
  }
  throw new Error('Unexpected answer from the API.');
}

function isTurn(value: unknown): value is Turn {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && typeof v.day_id === 'number';
}

/** The Day with its Lines in order. */
export async function getDay(id: number): Promise<Day> {
  return expectDay(await request('GET', `days/${id}`));
}

export async function getRoutine(id: number): Promise<RoutineDetail> {
  return expectDetail(await request('GET', `routines/${id}`));
}

function expectDetail(body: unknown): RoutineDetail {
  const routine = expectRoutine(body);
  const v = body as Record<string, unknown>;
  const next = v.next_turn_id;
  if (
    !Array.isArray(v.days) ||
    !Array.isArray(v.rotation) ||
    !v.rotation.every(isTurn) ||
    !(next === null || typeof next === 'number')
  ) {
    throw new Error('Unexpected answer from the API.');
  }
  return { ...routine, days: v.days.map(expectDay), rotation: v.rotation, next_turn_id: next };
}

/** A new Day has no Lines and gets one Turn at the end of the rotation. */
export async function createDay(routineId: number, name: string): Promise<Day> {
  return expectDay(await request('POST', `routines/${routineId}/days`, { name }));
}

export async function renameDay(id: number, name: string): Promise<Day> {
  return expectDay(await request('PATCH', `days/${id}`, { name }));
}

/**
 * Adds a Line at the end. A live Exercise's name attaches it; a new name creates it; a Retired
 * Exercise's name is refused with `name_retired`.
 */
export async function addLine(dayId: number, exerciseName: string): Promise<Day> {
  return expectDay(await request('POST', `days/${dayId}/lines`, { name: exerciseName }));
}

/** Refused with `lines_changed` unless `lineIds` names every Line of the Day once. */
export async function reorderLines(dayId: number, lineIds: number[]): Promise<Day> {
  return expectDay(await request('PUT', `days/${dayId}/lines`, { line_ids: lineIds }));
}

export async function removeLine(dayId: number, lineId: number): Promise<Day> {
  return expectDay(await request('DELETE', `days/${dayId}/lines/${lineId}`));
}

/** Adds a Turn for the Day at the end of the rotation. A Day may have several. */
export async function addTurn(routineId: number, dayId: number): Promise<RoutineDetail> {
  return expectDetail(await request('POST', `routines/${routineId}/turns`, { day_id: dayId }));
}

/** Refused with `rotation_changed` unless `turnIds` names every Turn of the rotation once. */
export async function reorderTurns(routineId: number, turnIds: number[]): Promise<RoutineDetail> {
  return expectDetail(await request('PUT', `routines/${routineId}/turns`, { turn_ids: turnIds }));
}

export async function removeTurn(routineId: number, turnId: number): Promise<RoutineDetail> {
  return expectDetail(await request('DELETE', `routines/${routineId}/turns/${turnId}`));
}

/** Removes all of the Day's Turns; the Day stays, off the rotation. */
export async function dropDay(dayId: number): Promise<RoutineDetail> {
  return expectDetail(await request('POST', `days/${dayId}/drop`));
}

/** Puts a Day that is off the rotation back on, with one Turn at the end. */
export async function putBackDay(dayId: number): Promise<RoutineDetail> {
  return expectDetail(await request('POST', `days/${dayId}/put-back`));
}

/**
 * A new Routine under a new unique name, copying every Day with its Lines and the Turns in order.
 * No Sessions or Skips; not engaged; no link back.
 */
export async function duplicateRoutine(id: number, name: string): Promise<RoutineDetail> {
  return expectDetail(await request('POST', `routines/${id}/duplicate`, { name }));
}

/**
 * Refused with `routine_pinned` while any Session or Skip points at it or its Days, and with
 * `routine_engaged` for the Engaged Routine while another Routine exists. Destroying the only
 * Routine returns the app to first run.
 */
export async function destroyRoutine(id: number): Promise<void> {
  await request('DELETE', `routines/${id}`);
}

/**
 * Copies the Day into this Routine or another, under a name unique there, with one Turn at the end
 * of that rotation. Answers with the target Routine.
 */
export async function duplicateDay(dayId: number, routineId: number, name: string): Promise<RoutineDetail> {
  return expectDetail(await request('POST', `days/${dayId}/duplicate`, { routine_id: routineId, name }));
}

/**
 * Destroys the Day with its Turns and Lines; its Exercises stay. Refused with `day_pinned` while a
 * Session or Skip points at it (Drop it instead). Answers with its Routine.
 */
export async function destroyDay(dayId: number): Promise<RoutineDetail> {
  return expectDetail(await request('DELETE', `days/${dayId}`));
}
