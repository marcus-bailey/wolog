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
  /** Days of the Routine with no Turn; their ids are 100 × Routine id + 50 + index. */
  offRotation?: string[];
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
  turn_id: number | null;
  version: number;
  lines: { id: number; exercise: { id: number; name: string; retired: boolean }; sets: FakeSet[] }[];
}

/**
 * The API's Routine list, engage, Up next, Skip and Undo, Days, and Sessions, in memory. The
 * suggestion follows the API's rule: the Turn after the latest Skip's or Session's, wrapping; else
 * the first. A first save is refused if the Engaged Routine, the suggestion or the date's Session
 * changed, as the API does.
 */
export function fakeTodayApi(routines: FakeRoutine[], sessions: FakeSession[] = [], retired: string[] = []) {
  let nextId = 1000;
  const exerciseIds = new Map<string, number>();
  const exercise = (typed: string) => {
    const name = typed.trim().replace(/\s+/g, ' ');
    const known = [...exerciseIds.keys()].find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    if (!exerciseIds.has(known)) exerciseIds.set(known, exerciseIds.size + 1);
    return { id: exerciseIds.get(known)!, name: known, retired: retired.includes(known) };
  };
  const retiredRefusal = (name: string) =>
    json(409, { code: 'name_retired', message: `“${name}” is a Retired Exercise. Un-retire it to use it again.` });
  const turnId = (r: FakeRoutine, i: number) => r.id * 100 + i;
  /** Every Day of the Routine: one per Turn (same id as its Turn), then those off the rotation. */
  const days = (r: FakeRoutine) => [
    ...r.turns.map((name, i) => ({ id: turnId(r, i), name })),
    ...(r.offRotation ?? []).map((name, i) => ({ id: r.id * 100 + 50 + i, name })),
  ];
  const dayById = (id: number) => {
    const r = routines.find((x) => x.id === Math.floor(id / 100))!;
    return { routine: r, day: days(r).find((d) => d.id === id)! };
  };
  const linesOf = (dayId: number) => {
    const { routine, day } = dayById(dayId);
    return (routine.lines?.[day.name] ?? []).map((name, j) => ({ id: dayId * 10 + j, exercise: exercise(name) }));
  };
  const dayLines = (r: FakeRoutine, i: number) => linesOf(turnId(r, i));

  /** The cursor; with `on`, as of that date (only pins dated on or before it). */
  function cursor(r: FakeRoutine, on?: string): number | undefined {
    const pins = [
      ...r.skips.map((s) => ({ date: s.date, seq: s.id, turn: s.turn })),
      ...sessions
        .filter((s) => s.routine.id === r.id && s.turn_id !== null)
        .map((s) => ({ date: s.date, seq: s.id, turn: s.turn_id! % 100 })),
    ]
      .filter((p) => on === undefined || p.date <= on)
      .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    return pins.at(-1)?.turn;
  }

  function upNext(on?: string) {
    const r = routines.find((x) => x.engaged);
    if (!r) return { routine: null, suggestion: null, last_skip: null };
    const last = r.skips.at(-1);
    const at = cursor(r, on);
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

  /**
   * Last-time as the API derives it: the latest Session dated before `before` with a Set of the
   * Exercise, its Sets by Line, and the prefill source. The fake matches Exercises by name, so
   * seeded Sessions need not share the ids it hands out.
   */
  function lastTime(q: URLSearchParams) {
    const before = q.get('before')!;
    const id = q.get('exercise_id');
    const typed = q.get('name');
    const known = [
      ...[...exerciseIds].map(([n, i]) => ({ id: i, name: n })),
      ...sessions.flatMap((s) => s.lines.map((l) => l.exercise)),
    ];
    const asked = typed?.trim().replace(/\s+/g, ' ').toLowerCase();
    const named = known.find((e) => (id !== null ? e.id === Number(id) : e.name.toLowerCase() === asked));
    if (named === undefined) return { exercise_id: null, last_time: null, prefill: null };
    const name = named.name;
    const same = (l: FakeSession['lines'][number]) => l.exercise.name.toLowerCase() === name.toLowerCase();
    const found = sessions
      .filter((s) => s.date < before && s.lines.some((l) => same(l) && l.sets.length > 0))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const lines = found ? found.lines.filter((l) => same(l) && l.sets.length > 0).map((l) => ({ sets: l.sets })) : [];
    const sets = lines.flatMap((l) => l.sets);
    const first = sets.find((s) => !s.warmup) ?? sets[0];
    return {
      exercise_id: named.id,
      last_time: found ? { date: found.date, lines } : null,
      prefill: first ? { reps: first.reps, weight: first.weight } : null,
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
    if (path.startsWith('up-next?on=')) return json(200, upNext(path.slice('up-next?on='.length)));
    const engage = /^routines\/(\d+)\/engage$/.exec(path);
    if (engage) {
      for (const r of routines) r.engaged = r.id === Number(engage[1]);
      const r = routines.find((x) => x.engaged)!;
      return json(200, { id: r.id, name: r.name, engaged: true });
    }
    const day = /^days\/(\d+)$/.exec(path);
    if (day) {
      const id = Number(day[1]);
      return json(200, { id, name: dayById(id).day.name, lines: linesOf(id) });
    }
    const detail = /^routines\/(\d+)$/.exec(path);
    if (detail) {
      const r = routines.find((x) => x.id === Number(detail[1]))!;
      return json(200, {
        id: r.id,
        name: r.name,
        engaged: r.engaged,
        days: days(r).map((d) => ({ ...d, lines: linesOf(d.id) })),
        rotation: r.turns.map((_, i) => ({ id: turnId(r, i), day_id: turnId(r, i) })),
        next_turn_id: null,
      });
    }
    if (path.startsWith('exercises')) {
      return json(200, [...exerciseIds.keys()].map(exercise).filter((e) => !e.retired));
    }
    if (path === 'history') {
      const named = (r: FakeRoutine, i: number) => ({ id: turnId(r, i), name: r.turns[i]! });
      const rows = [
        ...sessions.map((x) => ({ kind: 'session', rank: 0, id: x.id, date: x.date, routine: x.routine, day: x.day })),
        ...routines.flatMap((r) =>
          r.skips.map((k) => ({ kind: 'skip', rank: 1, id: k.id, date: k.date, routine: { id: r.id, name: r.name }, day: named(r, k.turn) })),
        ),
      ].sort((a, b) => b.date.localeCompare(a.date) || a.rank - b.rank || b.id - a.id);
      return json(200, rows.map(({ kind, id, date, routine, day }) => ({ kind, id, date, routine, day })));
    }
    if (path.startsWith('last-time?')) return json(200, lastTime(new URLSearchParams(path.slice('last-time?'.length))));
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
      const date = body.date as string;
      const latestSession = sessions.filter((s) => s.routine.id === r.id).map((s) => s.date).sort().at(-1);
      const lastSkip = r.skips.map((s) => s.date).sort().at(-1);
      if (lastSkip && date < lastSkip && !(latestSession && date < latestSession)) {
        const allowed = latestSession ? `before ${latestSession}, the date of its latest Session, or on or after ${lastSkip}` : `on or after ${lastSkip}`;
        return json(409, { code: 'date_in_skip_gap', message: `${date} falls among the Skips of “${r.name}”. A new Session on it must be dated ${allowed}, the date of its last Skip.` });
      }
      const now = upNext(date);
      if (body.turn_id !== now.suggestion?.turn_id) {
        return json(409, { code: 'suggestion_changed', message: `Up next is now ${now.suggestion?.day_name}. Check it and try again.` });
      }
      const picked = (body.day_id as number | undefined) ?? (body.turn_id as number);
      if (Math.floor(picked / 100) !== r.id || picked % 100 >= r.turns.length) {
        return json(409, { code: 'day_off_rotation', message: `That Day is not on the rotation of “${r.name}”. Pick a Day on it.` });
      }
      const index = picked % 100;
      const lines = dayLines(r, index);
      const given = body.lines as { day_line_id?: number; name?: string; sets: Omit<FakeSet, 'id'>[] }[];
      const bad = given.find((l) => l.name !== undefined && exercise(l.name).retired);
      if (bad) return retiredRefusal(exercise(bad.name!).name);
      const session: FakeSession = {
        id: nextId++,
        date: body.date as string,
        routine: { id: r.id, name: r.name },
        day: { id: turnId(r, index), name: r.turns[index]! },
        turn_id: turnId(r, index),
        version: 1,
        lines: given.map((l) => ({
          id: nextId++,
          exercise: l.name !== undefined ? exercise(l.name) : lines.find((dl) => dl.id === l.day_line_id)!.exercise,
          sets: withIds(l.sets),
        })),
      };
      r.skips = r.skips.filter((s) => s.date !== session.date);
      sessions.push(session);
      return json(201, session);
    }
    const write = /^sessions\/(\d+)$/.exec(path);
    if (write) {
      const session = sessions.find((s) => s.id === Number(write[1]));
      if (!session) return json(404, { code: 'not_found', message: 'That Session no longer exists.' });
      if (method === 'DELETE') {
        sessions.splice(sessions.indexOf(session), 1);
        return new Response(null, { status: 204 });
      }
      if (body.version !== session.version) {
        return json(409, { code: 'session_changed', message: 'This Session changed since you loaded it. Reload and try again.' });
      }
      const given = body.lines as { id?: number; name?: string; sets: (Omit<FakeSet, 'id'> & { id?: number })[] }[];
      const bad = given.find((l) => l.name !== undefined && exercise(l.name).retired);
      if (bad) return retiredRefusal(exercise(bad.name!).name);
      if (!given.some((l) => l.sets.length > 0)) {
        sessions.splice(sessions.indexOf(session), 1);
        return json(200, null);
      }
      if (body.day_id !== undefined) {
        const { day } = dayById(body.day_id as number);
        session.day = day;
        session.turn_id = day.id % 100 < 50 ? day.id : null;
      }
      session.lines = given.map((l) =>
        l.id !== undefined
          ? { ...session.lines.find((x) => x.id === l.id)!, sets: withIds(l.sets) }
          : { id: nextId++, exercise: exercise(l.name!), sets: withIds(l.sets) },
      );
      session.version += 1;
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
