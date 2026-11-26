import { request } from '../api';
import { localToday } from '../dates';

/** The suggested Turn: `position` of `of` in the rotation, naming its Day. */
export interface Suggestion {
  turn_id: number;
  day_id: number;
  day_name: string;
  position: number;
  of: number;
}

export interface LastSkip {
  id: number;
  date: string;
  day_id: number;
  day_name: string;
}

/** What Today shows before a Session. No Routine means first run; no suggestion, an empty rotation. */
export interface UpNext {
  routine: { id: number; name: string } | null;
  suggestion: Suggestion | null;
  last_skip: LastSkip | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isSuggestion(v: unknown): v is Suggestion {
  return (
    isObject(v) &&
    typeof v.turn_id === 'number' &&
    typeof v.day_id === 'number' &&
    typeof v.day_name === 'string' &&
    typeof v.position === 'number' &&
    typeof v.of === 'number'
  );
}

function isLastSkip(v: unknown): v is LastSkip {
  return (
    isObject(v) &&
    typeof v.id === 'number' &&
    typeof v.date === 'string' &&
    typeof v.day_id === 'number' &&
    typeof v.day_name === 'string'
  );
}

function expectUpNext(v: unknown): UpNext {
  if (
    isObject(v) &&
    (v.routine === null || (isObject(v.routine) && typeof v.routine.id === 'number' && typeof v.routine.name === 'string')) &&
    (v.suggestion === null || isSuggestion(v.suggestion)) &&
    (v.last_skip === null || isLastSkip(v.last_skip))
  ) {
    const routine = v.routine === null ? null : { id: v.routine.id as number, name: v.routine.name as string };
    return { routine, suggestion: v.suggestion, last_skip: v.last_skip };
  }
  throw new Error('Unexpected answer from the API.');
}

export async function getUpNext(): Promise<UpNext> {
  return expectUpNext(await request('GET', 'up-next'));
}

/**
 * Skip the suggestion the owner saw. Refused if the Engaged Routine or the suggestion changed since
 * (`routine_switched`, `suggestion_changed`), or the date is in the future or before the last Skip.
 */
export async function skip(routineId: number, turnId: number, date: string): Promise<UpNext> {
  return expectUpNext(
    await request('POST', 'skips', { routine_id: routineId, turn_id: turnId, date, today: localToday() }),
  );
}

/** Undo last Skip. Refused (`not_last_skip`) unless it is the Engaged Routine's last Skip. */
export async function undoSkip(skipId: number): Promise<UpNext> {
  return expectUpNext(await request('DELETE', `skips/${skipId}`));
}
