import { request } from '../api';

export interface Exercise {
  id: number;
  name: string;
}

function isExercise(value: unknown): value is Exercise {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'number' &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}

function expectExercise(value: unknown): Exercise {
  if (!isExercise(value)) throw new Error('Unexpected answer from the API.');
  return value;
}

export async function listExercises(): Promise<Exercise[]> {
  const body = await request('GET', 'exercises');
  if (!Array.isArray(body)) throw new Error('Unexpected answer from the API.');
  return body.map(expectExercise);
}

export async function createExercise(name: string): Promise<Exercise> {
  return expectExercise(await request('POST', 'exercises', { name }));
}
