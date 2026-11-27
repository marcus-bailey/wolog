import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../App';
import { localToday } from '../dates';
import { fakeTodayApi as fakeApi, type FakeRoutine } from './fakeApi';

afterEach(() => vi.unstubAllGlobals());

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
