import { request } from '../api';

export interface Exercise {
  id: number;
  name: string;
  /** Retired Exercises are hidden from pickers but keep their Lines and history. */
  retired: boolean;
}

function isExercise(value: unknown): value is Exercise {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && typeof v.name === 'string' && typeof v.retired === 'boolean';
}

function expectExercise(value: unknown): Exercise {
  if (!isExercise(value)) throw new Error('Unexpected answer from the API.');
  return value;
}

/** Every Exercise, Retired ones included. Pickers pass `{ retired: false }`. */
export async function listExercises(filter: { retired?: boolean } = {}): Promise<Exercise[]> {
  const query = filter.retired === undefined ? '' : `?retired=${filter.retired}`;
  const body = await request('GET', `exercises${query}`);
  if (!Array.isArray(body)) throw new Error('Unexpected answer from the API.');
  return body.map(expectExercise);
}

export async function createExercise(name: string): Promise<Exercise> {
  return expectExercise(await request('POST', 'exercises', { name }));
}

export async function renameExercise(id: number, name: string): Promise<Exercise> {
  return expectExercise(await request('PATCH', `exercises/${id}`, { name }));
}

export async function setRetired(id: number, retired: boolean): Promise<Exercise> {
  return expectExercise(await request('PATCH', `exercises/${id}`, { retired }));
}

/** Refused with `exercise_in_use` when the Exercise is on any Line; Retire it instead. */
export async function deleteExercise(id: number): Promise<void> {
  await request('DELETE', `exercises/${id}`);
}
