import { request } from '../api';

/** A row of History: a Session or a Skip, with its Routine and Day by their current names. */
export interface HistoryRow {
  kind: 'session' | 'skip';
  /** The Session's or the Skip's id. */
  id: number;
  date: string;
  routine: { id: number; name: string };
  day: { id: number; name: string };
}

function isNamed(v: unknown): v is { id: number; name: string } {
  return typeof v === 'object' && v !== null && typeof (v as { id: unknown }).id === 'number' && typeof (v as { name: unknown }).name === 'string';
}

function expectRow(v: unknown): HistoryRow {
  const r = v as Record<string, unknown>;
  if (
    typeof v === 'object' &&
    v !== null &&
    (r.kind === 'session' || r.kind === 'skip') &&
    typeof r.id === 'number' &&
    typeof r.date === 'string' &&
    isNamed(r.routine) &&
    isNamed(r.day)
  ) {
    return {
      kind: r.kind,
      id: r.id,
      date: r.date,
      routine: { id: r.routine.id, name: r.routine.name },
      day: { id: r.day.id, name: r.day.name },
    };
  }
  throw new Error('Unexpected answer from the API.');
}

/** Every Session and Skip across all Routines, newest first. */
export async function getHistory(): Promise<HistoryRow[]> {
  const body = await request('GET', 'history');
  if (!Array.isArray(body)) throw new Error('Unexpected answer from the API.');
  return body.map(expectRow);
}
