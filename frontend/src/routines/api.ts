import { request } from '../api';

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
