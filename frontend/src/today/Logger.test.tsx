import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../App';
import { localToday } from '../dates';
import { fakeTodayApi, type FakeRoutine } from './fakeApi';

afterEach(() => vi.unstubAllGlobals());

const ppl = (): FakeRoutine => ({
  id: 1,
  name: 'PPL',
  engaged: true,
  turns: ['Push', 'Pull'],
  skips: [],
  lines: { Push: ['Bench Press', 'Dips'], Pull: ['Rows'] },
});
const ul = (): FakeRoutine => ({
  id: 2,
  name: 'Upper Lower',
  engaged: false,
  turns: ['Upper'],
  skips: [],
  lines: { Upper: ['Overhead Press'] },
});

function renderToday() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

async function startPush() {
  renderToday();
  await userEvent.click(await screen.findByRole('button', { name: 'Start Push' }));
  return within(await screen.findByRole('region', { name: 'Logger' }));
}

function writes(fetch: ReturnType<typeof fakeTodayApi>['fetch']) {
  return fetch.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PUT');
}

async function fill(logger: ReturnType<typeof within>, weight: string, reps: string) {
  await userEvent.clear(logger.getByLabelText('Weight (lb)'));
  await userEvent.type(logger.getByLabelText('Weight (lb)'), weight);
  await userEvent.clear(logger.getByLabelText('Reps'));
  await userEvent.type(logger.getByLabelText('Reps'), reps);
}

it('Start only opens the Lines in the logger; nothing is saved', async () => {
  const { fetch } = fakeTodayApi([ppl()]);
  const logger = await startPush();

  expect(logger.getByRole('heading', { name: 'Push' })).toBeInTheDocument();
  const strip = within(logger.getByRole('navigation', { name: 'Lines' }));
  expect(strip.getAllByRole('button').map((b) => b.textContent)).toEqual(['Bench Press 0', 'Dips 0']);
  expect(logger.getByRole('heading', { name: 'Bench Press' })).toBeInTheDocument();
  expect(logger.getByLabelText('Date')).toHaveValue(localToday());
  expect(logger.getByLabelText('Date')).toHaveAttribute('max', localToday());
  expect(logger.getByRole('button', { name: 'Save Set 1' })).toBeInTheDocument();
  expect(writes(fetch)).toEqual([]);

  await userEvent.click(logger.getByRole('button', { name: 'Close' }));
  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
  expect(writes(fetch)).toEqual([]);
});

it('the first Set creates the Session from the Day’s Lines, pinning the suggestion', async () => {
  const { fetch, sessions } = fakeTodayApi([ppl()]);
  const logger = await startPush();

  await fill(logger, '45', '8');
  await userEvent.click(logger.getByRole('button', { name: 'Working' }));
  await userEvent.type(logger.getByLabelText('Note'), ' felt easy ');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));

  expect(await logger.findByRole('button', { name: 'Save Set 2' })).toBeInTheDocument();
  expect(writes(fetch)).toHaveLength(1);
  const [url, init] = writes(fetch)[0]!;
  expect(url).toBe('/wolog/api/sessions');
  expect(JSON.parse(init!.body as string)).toEqual({
    date: localToday(),
    today: localToday(),
    routine_id: 1,
    turn_id: 100,
    day_lines: [1000, 1001],
    lines: [
      { day_line_id: 1000, sets: [{ reps: 8, weight: '45', warmup: true, note: 'felt easy' }] },
      { day_line_id: 1001, sets: [] },
    ],
  });
  expect(sessions).toHaveLength(1);

  const sets = within(logger.getByRole('list', { name: 'Today’s Sets' }));
  const chip = sets.getByRole('listitem');
  expect(chip).toHaveTextContent(/^45 × 8 Warmup\s*• Note$/);
  expect(chip).toHaveClass('warmup');
  // Weight and Reps stay; the mark resets to Working and the Note to blank.
  expect(logger.getByLabelText('Weight (lb)')).toHaveValue('45');
  expect(logger.getByLabelText('Reps')).toHaveValue('8');
  expect(logger.getByRole('button', { name: 'Working' })).toHaveAttribute('aria-pressed', 'false');
  expect(logger.getByLabelText('Note')).toHaveValue('');
  expect(logger.getByRole('button', { name: /^Bench Press/ })).toHaveTextContent('Bench Press 1');
  // Once saved, the date is shown, not edited.
  expect(logger.queryByLabelText('Date')).not.toBeInTheDocument();
});

it('later Sets are written as the whole post-state of the Session', async () => {
  const { fetch } = fakeTodayApi([ppl()]);
  const logger = await startPush();
  await fill(logger, '135', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  await logger.findByRole('button', { name: 'Save Set 2' });

  await fill(logger, '140', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 2' }));
  await logger.findByRole('button', { name: 'Save Set 3' });

  const [url, init] = writes(fetch)[1]!;
  expect(url).toMatch(/\/wolog\/api\/sessions\/\d+$/);
  expect(init!.method).toBe('PUT');
  const lines = (JSON.parse(init!.body as string) as { lines: { id: number; sets: unknown[] }[] }).lines;
  expect(lines).toHaveLength(2);
  expect(lines[0]!.sets).toEqual([
    { id: expect.any(Number), reps: 5, weight: '135', warmup: false, note: null },
    { reps: 5, weight: '140', warmup: false, note: null },
  ]);
  expect(lines[1]!.sets).toEqual([]);
  const sets = within(logger.getByRole('list', { name: 'Today’s Sets' }));
  expect(sets.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['135 × 5', '140 × 5']);
});

it('steppers move Weight by 5 and Reps by 1, never below 0 and 1, and the values stay editable', async () => {
  fakeTodayApi([ppl()]);
  const logger = await startPush();
  const weight = logger.getByLabelText('Weight (lb)');
  const reps = logger.getByLabelText('Reps');

  await userEvent.click(logger.getByRole('button', { name: 'Weight +5' }));
  expect(weight).toHaveValue('5');
  await userEvent.click(logger.getByRole('button', { name: 'Weight −5' }));
  await userEvent.click(logger.getByRole('button', { name: 'Weight −5' }));
  expect(weight).toHaveValue('0');
  await userEvent.type(weight, '{backspace}22.5');
  await userEvent.click(logger.getByRole('button', { name: 'Weight +5' }));
  expect(weight).toHaveValue('27.5');

  await userEvent.click(logger.getByRole('button', { name: 'Reps −1' }));
  expect(reps).toHaveValue('1');
  await userEvent.click(logger.getByRole('button', { name: 'Reps +1' }));
  expect(reps).toHaveValue('2');
});

it('Previous and Next Line, and the chip strip, move one Line at a time and clear the inputs', async () => {
  fakeTodayApi([ppl()]);
  const logger = await startPush();
  expect(logger.getByRole('button', { name: 'Previous Line' })).toBeDisabled();
  await fill(logger, '100', '5');

  await userEvent.click(logger.getByRole('button', { name: 'Next Line' }));
  expect(logger.getByRole('heading', { name: 'Dips' })).toBeInTheDocument();
  expect(logger.getByRole('button', { name: /^Dips/ })).toHaveAttribute('aria-current', 'true');
  expect(logger.getByLabelText('Weight (lb)')).toHaveValue('');
  expect(logger.getByRole('button', { name: 'Next Line' })).toBeDisabled();

  await userEvent.click(logger.getByRole('button', { name: /^Bench Press/ }));
  expect(logger.getByRole('heading', { name: 'Bench Press' })).toBeInTheDocument();
});

it('a refused Set says why and keeps the inputs', async () => {
  const { fetch } = fakeTodayApi([ppl()]);
  const logger = await startPush();
  await fill(logger, '100', '2.5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Reps must be a whole number above 0.');
  expect(writes(fetch)).toEqual([]);
  expect(logger.getByLabelText('Weight (lb)')).toHaveValue('100');
});

it('if the Engaged Routine switched before the first Set, the save is refused and the logger reloads', async () => {
  const { routines, sessions } = fakeTodayApi([ppl(), ul()]);
  const logger = await startPush();
  for (const r of routines) r.engaged = r.id === 2; // switched elsewhere

  await fill(logger, '100', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('The Engaged Routine is now “Upper Lower”.');
  const reloaded = within(await screen.findByRole('region', { name: 'Logger' }));
  expect(await reloaded.findByRole('heading', { name: 'Upper' })).toBeInTheDocument();
  expect(reloaded.getByRole('heading', { name: 'Overhead Press' })).toBeInTheDocument();
  expect(sessions).toEqual([]);
});

it('a date that has a Session opens it, and today’s Session stays after switching Routines', async () => {
  const { sessions } = fakeTodayApi([ppl(), ul()]);
  const logger = await startPush();
  await fill(logger, '135', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  await logger.findByRole('button', { name: 'Save Set 2' });
  expect(sessions).toHaveLength(1);

  await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Menu' })).getByRole('button', { name: 'Upper Lower' }));

  const after = within(await screen.findByRole('region', { name: 'Logger' }));
  expect(after.getByText('PPL')).toBeInTheDocument();
  expect(after.getByRole('heading', { name: 'Push' })).toBeInTheDocument();
  expect(after.getByRole('button', { name: 'Save Set 2' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /^Up next/ })).not.toBeInTheDocument();
});

it('opening Today on a date with a Session opens that Session', async () => {
  fakeTodayApi(
    [ppl()],
    [
      {
        id: 5,
        date: localToday(),
        routine: { id: 1, name: 'PPL' },
        day: { id: 101, name: 'Pull' },
        turn_id: 101,
        lines: [{ id: 6, exercise: { id: 9, name: 'Rows', retired: false }, sets: [{ id: 7, reps: 10, weight: '95', warmup: false, note: null }] }],
      },
    ],
  );
  renderToday();
  const logger = within(await screen.findByRole('region', { name: 'Logger' }));
  expect(logger.getByRole('heading', { name: 'Pull' })).toBeInTheDocument();
  expect(logger.getByText('Today')).toBeInTheDocument();
  expect(logger.getByRole('button', { name: 'Save Set 2' })).toBeInTheDocument();
});

it('changing the logger’s date to one with a Session opens that Session', async () => {
  fakeTodayApi(
    [ppl()],
    [
      {
        id: 5,
        date: '2026-01-05',
        routine: { id: 1, name: 'PPL' },
        day: { id: 101, name: 'Pull' },
        turn_id: 101,
        lines: [{ id: 6, exercise: { id: 9, name: 'Rows', retired: false }, sets: [] }],
      },
    ],
  );
  const logger = await startPush();
  // A date picker sets the whole date at once.
  fireEvent.change(logger.getByLabelText('Date'), { target: { value: '2026-01-05' } });

  expect(await screen.findByRole('heading', { name: 'Pull' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Back to today' }));
  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
});

it('a Day with no Lines says so and links to its Routine', async () => {
  fakeTodayApi([{ ...ppl(), lines: {} }]);
  const logger = await startPush();
  expect(logger.getByText('Push has no Lines.')).toBeInTheDocument();
  expect(logger.getByRole('link', { name: 'Open PPL' })).toHaveAttribute('href', '/routines/1');
});
