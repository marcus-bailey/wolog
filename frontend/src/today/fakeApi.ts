import { vi } from 'vitest';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface FakeRoutine {
  id: number;
  name: string;
  engaged: boolean;
  /** The rotation as Day names, one Turn each; Turn and Day ids are 100 × Routine id + index. */
  turns: string[];
  skips: { id: number; date: string; turn: number }[];
  /** Each Day's Lines, as Exercise names, by Day name. */
  lines?: Record<string, string[]>;
}

interface FakeSet {
  id: number;
  reps: number;
  weight: string;
  warmup: boolean;
  note: string | null;
}

interface FakeSession {
  id: number;
  date: string;
  routine: { id: number; name: string };
  day: { id: number; name: string };
  turn_id: number;
  lines: { id: number; exercise: { id: number; name: string; retired: boolean }; sets: FakeSet[] }[];
}

/**
 * The API's Routine list, engage, Up next, Skip and Undo, Days, and Sessions, in memory. The
 * suggestion follows the API's rule: the Turn after the latest Skip's or Session's, wrapping; else
 * the first. A first save is refused if the Engaged Routine, the suggestion or the date's Session
 * changed, as the API does.
 */
export function fakeTodayApi(routines: FakeRoutine[], sessions: FakeSession[] = []) {
  let nextId = 1000;
  const exerciseIds = new Map<string, number>();
  const exercise = (name: string) => {
    if (!exerciseIds.has(name)) exerciseIds.set(name, exerciseIds.size + 1);
    return { id: exerciseIds.get(name)!, name, retired: false };
  };
  const turnId = (r: FakeRoutine, i: number) => r.id * 100 + i;
  const dayLines = (r: FakeRoutine, i: number) =>
    (r.lines?.[r.turns[i]!] ?? []).map((name, j) => ({ id: turnId(r, i) * 10 + j, exercise: exercise(name) }));

  function cursor(r: FakeRoutine): number | undefined {
    const pins = [
      ...r.skips.map((s) => ({ date: s.date, seq: s.id, turn: s.turn })),
      ...sessions.filter((s) => s.routine.id === r.id).map((s) => ({ date: s.date, seq: s.id, turn: s.turn_id % 100 })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    return pins.at(-1)?.turn;
  }

  function upNext() {
    const r = routines.find((x) => x.engaged);
    if (!r) return { routine: null, suggestion: null, last_skip: null };
    const last = r.skips.at(-1);
    const at = cursor(r);
    const index = r.turns.length === 0 ? -1 : at !== undefined ? (at + 1) % r.turns.length : 0;
    return {
      routine: { id: r.id, name: r.name, engaged: true },
      suggestion:
        index < 0
          ? null
          : {
              turn_id: turnId(r, index),
              day_id: turnId(r, index),
              day_name: r.turns[index],
              position: index + 1,
              of: r.turns.length,
            },
      last_skip: last ? { id: last.id, date: last.date, day_id: turnId(r, last.turn), day_name: r.turns[last.turn] } : null,
    };
  }

  const withIds = (sets: (Omit<FakeSet, 'id'> & { id?: number })[]): FakeSet[] =>
    sets.map((s) => ({ ...s, id: s.id ?? nextId++ }));

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/wolog/api/', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (path === 'routines') return json(200, routines.map(({ id, name, engaged }) => ({ id, name, engaged })));
    if (path === 'up-next') return json(200, upNext());
    const engage = /^routines\/(\d+)\/engage$/.exec(path);
    if (engage) {
      for (const r of routines) r.engaged = r.id === Number(engage[1]);
      const r = routines.find((x) => x.engaged)!;
      return json(200, { id: r.id, name: r.name, engaged: true });
    }
    const day = /^days\/(\d+)$/.exec(path);
    if (day) {
      const id = Number(day[1]);
      const r = routines.find((x) => x.id === Math.floor(id / 100))!;
      return json(200, { id, name: r.turns[id % 100], lines: dayLines(r, id % 100) });
    }
    const on = /^sessions\/on\/(.+)$/.exec(path);
    if (on) return json(200, sessions.find((s) => s.date === on[1]) ?? null);
    const r = routines.find((x) => x.engaged)!;
    if (method === 'POST' && path === 'sessions') {
      if (body.routine_id !== r.id) {
        return json(409, { code: 'routine_switched', message: `The Engaged Routine is now “${r.name}”. Up next has changed; check it and try again.` });
      }
      if (sessions.some((s) => s.date === body.date)) {
        return json(409, { code: 'session_exists', message: 'There is already a Session on that date. It is open now; save your Set there.' });
      }
      const now = upNext();
      if (body.turn_id !== now.suggestion?.turn_id) {
        return json(409, { code: 'suggestion_changed', message: `Up next is now ${now.suggestion?.day_name}. Check it and try again.` });
      }
      const index = (body.turn_id as number) % 100;
      const lines = dayLines(r, index);
      const session: FakeSession = {
        id: nextId++,
        date: body.date as string,
        routine: { id: r.id, name: r.name },
        day: { id: turnId(r, index), name: r.turns[index]! },
        turn_id: body.turn_id as number,
        lines: (body.lines as { day_line_id: number; sets: Omit<FakeSet, 'id'>[] }[]).map((l) => ({
          id: nextId++,
          exercise: lines.find((dl) => dl.id === l.day_line_id)!.exercise,
          sets: withIds(l.sets),
        })),
      };
      r.skips = r.skips.filter((s) => s.date !== session.date);
      sessions.push(session);
      return json(201, session);
    }
    const write = /^sessions\/(\d+)$/.exec(path);
    if (method === 'PUT' && write) {
      const session = sessions.find((s) => s.id === Number(write[1]));
      if (!session) return json(404, { code: 'not_found', message: 'That Session no longer exists.' });
      const given = body.lines as { id: number; sets: (Omit<FakeSet, 'id'> & { id?: number })[] }[];
      session.lines = given.map((l) => ({ ...session.lines.find((x) => x.id === l.id)!, sets: withIds(l.sets) }));
      return json(200, session);
    }
    if (method === 'POST' && path === 'skips') {
      const now = upNext();
      if (body.turn_id !== now.suggestion?.turn_id) {
        return json(409, { code: 'suggestion_changed', message: `Up next is now ${now.suggestion?.day_name}. Check it and try again.` });
      }
      r.skips.push({ id: nextId++, date: body.date as string, turn: (body.turn_id as number) % 100 });
      return json(201, upNext());
    }
    if (method === 'DELETE' && path.startsWith('skips/')) {
      r.skips.pop();
      return json(200, upNext());
    }
    return json(405, {});
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, routines, sessions };
}
