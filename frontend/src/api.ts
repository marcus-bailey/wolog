import { goToSignIn } from './session';

/** The API sits under the app's base path: /wolog/api/ in production (spec §8). */
export const API_BASE = `${import.meta.env.BASE_URL}api/`;

/** The API refused the action; message says why, in plain words (spec §7). */
export class Refused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'Refused';
    this.code = code;
  }
}

function isRefusal(body: unknown): body is { code: string; message: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>).code === 'string' &&
    typeof (body as Record<string, unknown>).message === 'string'
  );
}

/**
 * Calls the API. A 401 means the login's session ran out: go and sign in (the returned promise
 * then never settles, so no error flashes up while the page leaves).
 */
export async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    if (goToSignIn()) return new Promise(() => {});
    throw new Error('You are signed out, and signing in again did not help. Reload the page to try again.');
  }
  const data: unknown = res.headers.get('Content-Type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (isRefusal(data)) throw new Refused(data.code, data.message);
    throw new Error(`Something went wrong (HTTP ${res.status}). Try again.`);
  }
  return data;
}

/** What to tell the owner when an action fails: the API's refusal, or a plain fallback. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.';
}
