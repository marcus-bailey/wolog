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
}

function isLine(value: unknown): value is Line {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && isExercise(v.exercise);
}

function expectDay(value: unknown): Day {
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

export async function getRoutine(id: number): Promise<RoutineDetail> {
  const body = await request('GET', `routines/${id}`);
  const routine = expectRoutine(body);
  const v = body as Record<string, unknown>;
  if (!Array.isArray(v.days) || !Array.isArray(v.rotation) || !v.rotation.every(isTurn)) {
    throw new Error('Unexpected answer from the API.');
  }
  return { ...routine, days: v.days.map(expectDay), rotation: v.rotation };
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
