import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../App';
import { localToday } from '../dates';

afterEach(() => vi.unstubAllGlobals());

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface FakeRoutine {
  id: number;
  name: string;
  engaged: boolean;
  /** The rotation as Day names; Turn ids are 100 × Routine id + index. */
  turns: string[];
  skips: { id: number; date: string; turn: number }[];
}

/**
 * The API's Routine list, engage, Up next, Skip and Undo, in memory. The suggestion follows the
 * API's rule: the Turn after the last Skip's, wrapping; else the first.
 */
function fakeApi(routines: FakeRoutine[]) {
  let nextSkip = 1;
  const turnId = (r: FakeRoutine, i: number) => r.id * 100 + i;
  function upNext() {
    const r = routines.find((x) => x.engaged);
    if (!r) return { routine: null, suggestion: null, last_skip: null };
    const last = r.skips.at(-1);
    const index = r.turns.length === 0 ? -1 : last ? (last.turn + 1) % r.turns.length : 0;
    return {
      routine: { id: r.id, name: r.name, engaged: true },
      suggestion:
        index < 0
          ? null
          : { turn_id: turnId(r, index), day_id: index, day_name: r.turns[index], position: index + 1, of: r.turns.length },
      last_skip: last ? { id: last.id, date: last.date, day_id: last.turn, day_name: r.turns[last.turn] } : null,
    };
  }
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
    const r = routines.find((x) => x.engaged)!;
    if (method === 'POST' && path === 'skips') {
      const now = upNext();
      if (body.turn_id !== now.suggestion?.turn_id) {
        return json(409, { code: 'suggestion_changed', message: `Up next is now ${now.suggestion?.day_name}. Check it and try again.` });
      }
      r.skips.push({ id: nextSkip++, date: body.date as string, turn: (body.turn_id as number) % 100 });
      return json(201, upNext());
    }
    if (method === 'DELETE' && path.startsWith('skips/')) {
      r.skips.pop();
      return json(200, upNext());
    }
    return json(405, {});
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, routines };
}

function renderToday() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

const ppl = (): FakeRoutine => ({ id: 1, name: 'PPL', engaged: true, turns: ['Push', 'Pull', 'Legs'], skips: [] });
const ul = (): FakeRoutine => ({ id: 2, name: 'Upper Lower', engaged: false, turns: ['Upper', 'Lower'], skips: [] });

async function card() {
  return within(await screen.findByRole('region', { name: /^Up next/ }));
}

it('shows Up next: the Routine, Turn n of N, and the suggested Day; not the rotation', async () => {
  fakeApi([ppl()]);
  renderToday();

  const upNext = await card();
  expect(upNext.getByRole('heading', { name: 'Up next · PPL' })).toBeInTheDocument();
  expect(upNext.getByText('Turn 1 of 3')).toBeInTheDocument();
  expect(upNext.getByText('Push')).toHaveClass('suggested-day');
  expect(screen.queryByText('Pull')).not.toBeInTheDocument();
  expect(screen.queryByText('Legs')).not.toBeInTheDocument();
  expect(upNext.queryByRole('button', { name: /Undo last Skip/ })).not.toBeInTheDocument();
});

it('Skip it passes the suggestion seen, dated today, and Up next moves on', async () => {
  const { fetch } = fakeApi([ppl()]);
  renderToday();
  const upNext = await card();

  expect(upNext.getByLabelText('Skip date')).toHaveValue(localToday());
  expect(upNext.getByLabelText('Skip date')).toHaveAttribute('max', localToday());
  await userEvent.click(upNext.getByRole('button', { name: 'Skip it' }));

  expect(await upNext.findByText('Pull')).toHaveClass('suggested-day');
  expect(upNext.getByText('Turn 2 of 3')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(
    '/wolog/api/skips',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ routine_id: 1, turn_id: 100, date: localToday(), today: localToday() }),
    }),
  );
  expect(upNext.getByRole('button', { name: /^Undo last Skip \(Push, / })).toBeInTheDocument();
});

it('a Skip may be dated earlier', async () => {
  const { fetch } = fakeApi([ppl()]);
  renderToday();
  const upNext = await card();

  const input = upNext.getByLabelText('Skip date');
  await userEvent.clear(input);
  await userEvent.type(input, '2026-01-05');
  await userEvent.click(upNext.getByRole('button', { name: 'Skip it' }));

  await upNext.findByText('Turn 2 of 3');
  expect(fetch).toHaveBeenCalledWith('/wolog/api/skips', expect.objectContaining({ body: expect.stringContaining('"date":"2026-01-05"') }));
});

it('Undo last Skip removes it and appears only while there is one', async () => {
  const routine = ppl();
  routine.skips.push({ id: 7, date: '2026-01-05', turn: 0 });
  const { fetch } = fakeApi([routine]);
  renderToday();
  const upNext = await card();
  expect(upNext.getByText('Turn 2 of 3')).toBeInTheDocument();

  await userEvent.click(upNext.getByRole('button', { name: /^Undo last Skip \(Push, / }));
  expect(await upNext.findByText('Turn 1 of 3')).toBeInTheDocument();
  expect(upNext.queryByRole('button', { name: /Undo last Skip/ })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/wolog/api/skips/7', expect.objectContaining({ method: 'DELETE' }));
});

it('with an empty rotation, says so, links to the Routine editor, and offers no Skip', async () => {
  fakeApi([{ ...ppl(), turns: [] }]);
  renderToday();
  const upNext = await card();

  expect(upNext.getByText('Nothing is on the rotation.')).toBeInTheDocument();
  expect(upNext.getByRole('link', { name: 'Open PPL' })).toHaveAttribute('href', '/routines/1');
  expect(upNext.queryByRole('button', { name: 'Skip it' })).not.toBeInTheDocument();
});

it('a refused Skip says why and shows the current Up next', async () => {
  const { routines } = fakeApi([ppl()]);
  renderToday();
  const upNext = await card();
  routines[0]?.skips.push({ id: 99, date: localToday(), turn: 0 }); // skipped elsewhere meanwhile

  await userEvent.click(upNext.getByRole('button', { name: 'Skip it' }));
  expect(await upNext.findByRole('alert')).toHaveTextContent('Up next is now Pull. Check it and try again.');
  expect(await upNext.findByText('Turn 2 of 3')).toBeInTheDocument();
});

it('switching Routines recomputes Up next, and returning resumes where it left off', async () => {
  fakeApi([ppl(), ul()]);
  renderToday();
  let upNext = await card();
  await userEvent.click(upNext.getByRole('button', { name: 'Skip it' }));
  await upNext.findByText('Turn 2 of 3');

  const drawer = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    return within(screen.getByRole('navigation', { name: 'Menu' }));
  };
  await userEvent.click((await drawer()).getByRole('button', { name: 'Upper Lower' }));
  await screen.findByRole('heading', { name: 'Up next · Upper Lower' });
  upNext = await card();
  expect(upNext.getByText('Upper')).toHaveClass('suggested-day');
  expect(upNext.getByText('Turn 1 of 2')).toBeInTheDocument();

  await userEvent.click((await drawer()).getByRole('button', { name: 'PPL' }));
  await screen.findByRole('heading', { name: 'Up next · PPL' });
  upNext = await card();
  expect(upNext.getByText('Pull')).toHaveClass('suggested-day');
});
