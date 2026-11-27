import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../App';
import { localToday, shownDate } from '../dates';
import { fakeTodayApi, type FakeRoutine } from '../today/fakeApi';

afterEach(() => vi.unstubAllGlobals());

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localToday(d);
}

const ppl = (): FakeRoutine => ({
  id: 1,
  name: 'PPL',
  engaged: true,
  turns: ['Push', 'Pull', 'Legs'],
  skips: [{ id: 900, date: daysAgo(5), turn: 0 }],
  lines: { Push: ['Bench Press'], Pull: ['Rows'], Legs: ['Squat'] },
});
const ul = (): FakeRoutine => ({
  id: 2,
  name: 'Upper Lower',
  engaged: false,
  turns: ['Upper', 'Lower'],
  skips: [{ id: 901, date: daysAgo(1), turn: 1 }],
});
const session = (id: number, date: string, routine: { id: number; name: string }, day: { id: number; name: string }) => ({
  id,
  date,
  routine,
  day,
  turn_id: day.id,
  version: 1,
  lines: [{ id: id + 1, exercise: { id: 9, name: 'Rows', retired: false }, sets: [{ id: id + 2, reps: 10, weight: '95', warmup: false, note: null }] }],
});

function renderHistory() {
  render(
    <MemoryRouter initialEntries={['/history']}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

it('lists every Session and Skip across Routines, newest first; Skips read as passes', async () => {
  fakeTodayApi(
    [ppl(), ul()],
    [
      session(10, daysAgo(3), { id: 1, name: 'PPL' }, { id: 101, name: 'Pull' }),
      session(20, daysAgo(2), { id: 2, name: 'Upper Lower' }, { id: 200, name: 'Upper' }),
    ],
  );
  renderHistory();

  const list = within(await screen.findByRole('list', { name: 'Sessions and Skips' }));
  expect(list.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    `${shownDate(daysAgo(1))}Skipped LowerUpper Lower`,
    `${shownDate(daysAgo(2))}UpperUpper Lower`,
    `${shownDate(daysAgo(3))}PullPPL`,
    `${shownDate(daysAgo(5))}Skipped PushPPL`,
  ]);
  // Sessions open; Skips are not Sessions and open nothing.
  expect(list.getAllByRole('link')).toHaveLength(2);
});

it('with nothing logged, says so', async () => {
  fakeTodayApi([{ ...ppl(), skips: [] }]);
  renderHistory();
  expect(await screen.findByText('No Sessions or Skips yet.')).toBeInTheDocument();
});

it('tapping a Session opens it in the logger, where it can be edited', async () => {
  const { sessions } = fakeTodayApi([ppl()], [session(10, daysAgo(3), { id: 1, name: 'PPL' }, { id: 101, name: 'Pull' })]);
  renderHistory();
  await userEvent.click(await screen.findByRole('link', { name: /Pull/ }));

  const logger = within(await screen.findByRole('region', { name: 'Logger' }));
  expect(logger.getByRole('heading', { name: 'Pull' })).toBeInTheDocument();
  expect(logger.getByText(shownDate(daysAgo(3)))).toBeInTheDocument();
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 2' }));
  expect(await logger.findByRole('button', { name: 'Save Set 3' })).toBeInTheDocument();
  expect(sessions[0]!.lines[0]!.sets).toHaveLength(2);

  // Back to today leaves the past Session for Up next.
  await userEvent.click(logger.getByRole('button', { name: 'Back to today' }));
  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
});

it('deleting a Session opened from History comes back to a fresh Today', async () => {
  fakeTodayApi([ppl()], [session(10, daysAgo(3), { id: 1, name: 'PPL' }, { id: 101, name: 'Pull' })]);
  renderHistory();
  await userEvent.click(await screen.findByRole('link', { name: /Pull/ }));
  const logger = within(await screen.findByRole('region', { name: 'Logger' }));
  await userEvent.click(logger.getByRole('button', { name: 'Delete Session…' }));
  await userEvent.click(logger.getByRole('button', { name: 'Delete Session' }));

  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Session deleted.');
});

it('a Session gone since History loaded says so and shows today', async () => {
  const { sessions } = fakeTodayApi([ppl()], [session(10, daysAgo(3), { id: 1, name: 'PPL' }, { id: 101, name: 'Pull' })]);
  renderHistory();
  const link = await screen.findByRole('link', { name: /Pull/ });
  sessions.splice(0); // deleted elsewhere
  await userEvent.click(link);

  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(`There is no Session on ${shownDate(daysAgo(3))} any more.`);
});

it('a date that does not exist is ignored', async () => {
  fakeTodayApi([ppl()]);
  render(
    <MemoryRouter initialEntries={['/?on=2024-02-30']}>
      <AppRoutes />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
});
