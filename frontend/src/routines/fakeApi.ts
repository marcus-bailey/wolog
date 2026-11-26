import { vi } from 'vitest';
import type { Routine } from './api';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A stand-in for the API's Routine routes, for component tests: keeps Routines in memory with
 * the API's rules (first one engaged, names unique case-insensitively, one engaged).
 */
export function fakeRoutinesApi(initial: Routine[] = []) {
  const routines = initial.map((r) => ({ ...r }));
  let nextId = Math.max(0, ...routines.map((r) => r.id)) + 1;
  const taken = (name: string, id?: number) =>
    routines.find((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase());

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/wolog/api/', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as { name: string }) : null;
    if (method === 'GET' && path === 'routines') return json(200, routines);
    if (method === 'GET' && path.startsWith('exercises')) return json(200, []);
    if (method === 'POST' && path === 'routines' && body) {
      const name = body.name.trim().replace(/\s+/g, ' ');
      const other = taken(name);
      if (other) return json(409, { code: 'name_taken', message: `There is already a Routine called “${other.name}”.` });
      const routine = { id: nextId++, name, engaged: routines.length === 0 };
      routines.push(routine);
      return json(201, routine);
    }
    const match = /^routines\/(\d+)(\/engage)?$/.exec(path);
    const routine = match && routines.find((r) => r.id === Number(match[1]));
    if (!routine) return json(404, { code: 'not_found', message: 'That Routine no longer exists.' });
    if (method === 'PATCH' && body) {
      const name = body.name.trim().replace(/\s+/g, ' ');
      const other = taken(name, routine.id);
      if (other) return json(409, { code: 'name_taken', message: `There is already a Routine called “${other.name}”.` });
      routine.name = name;
      return json(200, routine);
    }
    if (method === 'POST' && match?.[2]) {
      for (const r of routines) r.engaged = r === routine;
      return json(200, routine);
    }
    return json(405, { code: 'invalid_request', message: 'Not allowed.' });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, routines };
}
