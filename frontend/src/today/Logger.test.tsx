import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  expect(strip.getAllByRole('button').map((b) => b.textContent)).toEqual(['Bench Press 0', 'Dips 0', '+ Line']);
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
  const chip = sets.getByRole('button');
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
        version: 1,
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
        version: 1,
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

it('a Day with no Lines says so, and + Line adds one before the first Set', async () => {
  const { fetch } = fakeTodayApi([{ ...ppl(), lines: {} }]);
  const logger = await startPush();
  expect(logger.getByText('Push has no Lines. Add one with + Line.')).toBeInTheDocument();

  await userEvent.click(logger.getByRole('button', { name: '+ Line' }));
  await userEvent.type(logger.getByLabelText('Exercise'), '  Goblet   Squat ');
  await userEvent.click(logger.getByRole('button', { name: 'Add' }));
  expect(logger.getByRole('heading', { name: 'Goblet Squat' })).toBeInTheDocument();
  expect(writes(fetch)).toEqual([]);

  await fill(logger, '50', '10');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  await logger.findByRole('button', { name: 'Save Set 2' });
  const body = JSON.parse(writes(fetch)[0]![1]!.body as string) as { lines: unknown[] };
  expect(body.lines).toEqual([{ name: '  Goblet   Squat ', sets: [{ reps: 10, weight: '50', warmup: false, note: null }] }]);
});

// Editing a Session (#21)

async function loggedPush(fake: ReturnType<typeof fakeTodayApi>, ...sets: [string, string][]) {
  const logger = await startPush();
  for (const [i, [weight, reps]] of sets.entries()) {
    await fill(logger, weight, reps);
    await userEvent.click(logger.getByRole('button', { name: `Save Set ${i + 1}` }));
    await logger.findByRole('button', { name: `Save Set ${i + 2}` });
  }
  expect(fake.sessions).toHaveLength(1);
  return logger;
}

function chips(logger: ReturnType<typeof within>) {
  const list = logger.queryByRole('list', { name: 'Today’s Sets' });
  return list ? within(list).getAllByRole('button').map((b) => b.textContent) : [];
}

function lastWrite(fetch: ReturnType<typeof fakeTodayApi>['fetch']) {
  const [url, init] = writes(fetch).at(-1)!;
  return { url, method: init!.method, body: JSON.parse(init!.body as string) as { version: number; lines: { id?: number; name?: string; sets: unknown[] }[] } };
}

it('tapping a Set chip opens an edit sheet that edits any field', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['135', '5']);

  await userEvent.click(logger.getByRole('button', { name: '135 × 5' }));
  const sheet = within(logger.getByRole('dialog', { name: 'Set 1' }));
  expect(sheet.getByLabelText('Weight (lb)')).toHaveValue('135');
  expect(sheet.getByLabelText('Reps')).toHaveValue('5');
  await userEvent.click(sheet.getByRole('button', { name: 'Weight +5' }));
  await userEvent.click(sheet.getByRole('button', { name: 'Reps −1' }));
  await userEvent.click(sheet.getByRole('button', { name: 'Working' }));
  await userEvent.type(sheet.getByLabelText('Note'), 'paused');
  await userEvent.click(sheet.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(chips(logger)).toEqual(['140 × 4 Warmup• Note']));
  expect(logger.queryByRole('dialog')).not.toBeInTheDocument();
  const { method, body } = lastWrite(fake.fetch);
  expect(method).toBe('PUT');
  expect(body.version).toBe(1);
  expect(body.lines[0]!.sets).toEqual([{ id: expect.any(Number), reps: 4, weight: '140', warmup: true, note: 'paused' }]);

  // The full Note is in the sheet.
  await userEvent.click(logger.getByRole('button', { name: /^140 × 4/ }));
  expect(within(logger.getByRole('dialog', { name: 'Set 1' })).getByLabelText('Note')).toHaveValue('paused');
});

it('an invalid edit is refused and the sheet stays open', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['135', '5']);
  await userEvent.click(logger.getByRole('button', { name: '135 × 5' }));
  const sheet = within(logger.getByRole('dialog', { name: 'Set 1' }));
  await userEvent.clear(sheet.getByLabelText('Reps'));
  await userEvent.type(sheet.getByLabelText('Reps'), '0');
  await userEvent.click(sheet.getByRole('button', { name: 'Save' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Reps must be a whole number above 0.');
  expect(logger.getByRole('dialog', { name: 'Set 1' })).toBeInTheDocument();
  expect(chips(logger)).toEqual(['135 × 5']);
});

it('Sets move earlier and later within their Line', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['100', '5'], ['110', '5'], ['120', '5']);

  await userEvent.click(logger.getByRole('button', { name: '120 × 5' }));
  let sheet = within(logger.getByRole('dialog', { name: 'Set 3' }));
  expect(sheet.getByRole('button', { name: 'Later' })).toBeDisabled();
  await userEvent.click(sheet.getByRole('button', { name: 'Earlier' }));
  await screen.findByRole('dialog', { name: 'Set 2' });
  expect(chips(logger)).toEqual(['100 × 5', '120 × 5', '110 × 5']);

  sheet = within(logger.getByRole('dialog', { name: 'Set 2' }));
  await userEvent.click(sheet.getByRole('button', { name: 'Earlier' }));
  await screen.findByRole('dialog', { name: 'Set 1' });
  expect(chips(logger)).toEqual(['120 × 5', '100 × 5', '110 × 5']);
  expect(within(logger.getByRole('dialog', { name: 'Set 1' })).getByRole('button', { name: 'Earlier' })).toBeDisabled();
});

it('Delete in the sheet removes the Set; deleting the last Set erases the Session', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['100', '5'], ['110', '5']);

  await userEvent.click(logger.getByRole('button', { name: '100 × 5' }));
  await userEvent.click(within(logger.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await logger.findByRole('button', { name: 'Save Set 2' });
  expect(chips(logger)).toEqual(['110 × 5']);

  await userEvent.click(logger.getByRole('button', { name: '110 × 5' }));
  await userEvent.click(within(logger.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('status')).toHaveTextContent('The Session is gone: it had no Sets left.');
  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
  expect(fake.sessions).toEqual([]);
});

it('+ Line attaches or creates an Exercise as a new Line at the end, and opens it', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['135', '5']);

  await userEvent.click(logger.getByRole('button', { name: '+ Line' }));
  // The picker offers live Exercises.
  await waitFor(() =>
    expect([...document.querySelectorAll('#add-line-picks option')].map((o) => o.getAttribute('value'))).toEqual([
      'Bench Press',
      'Dips',
    ]),
  );
  await userEvent.type(logger.getByLabelText('Exercise'), 'bench press');
  await userEvent.click(logger.getByRole('button', { name: 'Add' }));

  const strip = within(logger.getByRole('navigation', { name: 'Lines' }));
  await waitFor(() =>
    expect(strip.getAllByRole('button').map((b) => b.textContent)).toEqual(['Bench Press 1', 'Dips 0', 'Bench Press 0', '+ Line']),
  );
  expect(strip.getAllByRole('button')[2]).toHaveAttribute('aria-current', 'true');
  expect(logger.queryByLabelText('Exercise')).not.toBeInTheDocument();
  const { body } = lastWrite(fake.fetch);
  expect(body.lines.at(-1)).toEqual({ name: 'bench press', sets: [] });
});

it('+ Line refuses a Retired Exercise and keeps the name typed', async () => {
  const fake = fakeTodayApi([ppl()], [], ['Old Press']);
  const logger = await loggedPush(fake, ['135', '5']);
  await userEvent.click(logger.getByRole('button', { name: '+ Line' }));
  await userEvent.type(logger.getByLabelText('Exercise'), 'Old Press');
  await userEvent.click(logger.getByRole('button', { name: 'Add' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('“Old Press” is a Retired Exercise.');
  expect(logger.getByLabelText('Exercise')).toHaveValue('Old Press');
  expect(fake.sessions[0]!.lines).toHaveLength(2);
});

it('Remove Line is offered only while the Line has no Sets', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['135', '5']);
  expect(logger.queryByRole('button', { name: 'Remove Line' })).not.toBeInTheDocument();

  await userEvent.click(logger.getByRole('button', { name: 'Next Line' }));
  await userEvent.click(logger.getByRole('button', { name: 'Remove Line' }));

  const strip = within(logger.getByRole('navigation', { name: 'Lines' }));
  await waitFor(() => expect(strip.getAllByRole('button').map((b) => b.textContent)).toEqual(['Bench Press 1', '+ Line']));
  expect(lastWrite(fake.fetch).body.lines).toHaveLength(1);
});

it('before the first Set, removed Lines are left out of the new Session', async () => {
  const { fetch } = fakeTodayApi([ppl()]);
  const logger = await startPush();
  await userEvent.click(logger.getByRole('button', { name: 'Remove Line' }));
  expect(logger.getByRole('heading', { name: 'Dips' })).toBeInTheDocument();

  await fill(logger, '0', '10');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  await logger.findByRole('button', { name: 'Save Set 2' });
  const body = JSON.parse(writes(fetch)[0]![1]!.body as string) as { day_lines: number[]; lines: unknown[] };
  expect(body.day_lines).toEqual([1000, 1001]);
  expect(body.lines).toEqual([{ day_line_id: 1001, sets: [{ reps: 10, weight: '0', warmup: false, note: null }] }]);
});

it('Delete Session asks first, then erases it and goes back to Up next', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['135', '5']);

  await userEvent.click(logger.getByRole('button', { name: 'Delete Session…' }));
  await userEvent.click(logger.getByRole('button', { name: 'Keep it' }));
  expect(fake.sessions).toHaveLength(1);

  await userEvent.click(logger.getByRole('button', { name: 'Delete Session…' }));
  await userEvent.click(within(logger.getByRole('group', { name: 'Delete Session' })).getByRole('button', { name: 'Delete Session' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Session deleted.');
  expect(await screen.findByRole('region', { name: /^Up next/ })).toBeInTheDocument();
  expect(fake.sessions).toEqual([]);
  expect(fake.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/wolog\/api\/sessions\/\d+$/), expect.objectContaining({ method: 'DELETE' }));
});

it('a write refused because the Session changed elsewhere reloads it', async () => {
  const fake = fakeTodayApi([ppl()]);
  const logger = await loggedPush(fake, ['135', '5']);
  const session = fake.sessions[0]!;
  session.lines[0]!.sets.push({ id: 77, reps: 3, weight: '150', warmup: false, note: null });
  session.version += 1; // saved on another device

  await fill(logger, '140', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 2' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This Session changed since you loaded it.');
  await waitFor(() => expect(chips(logger)).toEqual(['135 × 5', '150 × 3']));
});

// Pick another Day and Change-Day (#22)

const ppl3 = (): FakeRoutine => ({
  id: 1,
  name: 'PPL',
  engaged: true,
  turns: ['Push', 'Pull', 'Legs'],
  skips: [],
  lines: { Push: ['Bench Press'], Pull: ['Rows'], Legs: ['Squat'], Arms: ['Curls'] },
  offRotation: ['Arms'],
});

it('Pick another Day lists the Days on the rotation; the card then notes what was suggested', async () => {
  fakeTodayApi([ppl3()]);
  renderToday();
  const card = within(await screen.findByRole('region', { name: /^Up next/ }));

  await userEvent.click(card.getByRole('button', { name: 'Pick another Day' }));
  const picker = within(card.getByRole('group', { name: 'Days on the rotation' }));
  expect(picker.getAllByRole('button').map((b) => b.textContent)).toEqual(['Push', 'Pull', 'Legs']);
  await userEvent.click(picker.getByRole('button', { name: 'Legs' }));

  expect(card.getByText('Legs')).toHaveClass('suggested-day');
  expect(card.getByText('Suggested: Push')).toBeInTheDocument();
  expect(card.queryByRole('button', { name: 'Skip it' })).not.toBeInTheDocument();
  await userEvent.click(card.getByRole('button', { name: 'Back to Push' }));
  expect(card.getByText('Push')).toHaveClass('suggested-day');
  expect(card.queryByText(/^Suggested:/)).not.toBeInTheDocument();
});

it('starting a picked Day opens its Lines, and the first Set pins it over the suggestion', async () => {
  const { fetch, sessions } = fakeTodayApi([ppl3()]);
  renderToday();
  const card = within(await screen.findByRole('region', { name: /^Up next/ }));
  await userEvent.click(card.getByRole('button', { name: 'Pick another Day' }));
  await userEvent.click(within(card.getByRole('group', { name: 'Days on the rotation' })).getByRole('button', { name: 'Legs' }));
  await userEvent.click(card.getByRole('button', { name: 'Start Legs' }));

  const logger = within(await screen.findByRole('region', { name: 'Logger' }));
  expect(logger.getByRole('heading', { name: 'Legs' })).toBeInTheDocument();
  expect(logger.getByText('Suggested: Push')).toBeInTheDocument();
  expect(logger.getByRole('heading', { name: 'Squat' })).toBeInTheDocument();

  await fill(logger, '225', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  await logger.findByRole('button', { name: 'Save Set 2' });
  const body = JSON.parse(writes(fetch)[0]![1]!.body as string) as Record<string, unknown>;
  expect(body).toMatchObject({ turn_id: 100, day_id: 102, day_lines: [1020] });
  expect(sessions[0]!.day.name).toBe('Legs');
});

it('Change Day offers every Day of the Session’s Routine and relabels it, keeping Lines and Sets', async () => {
  const fake = fakeTodayApi([ppl3()]);
  const logger = await loggedPush(fake, ['135', '5']);

  await userEvent.click(logger.getByRole('button', { name: 'Change Day…' }));
  const select = logger.getByLabelText('Day');
  expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Push', 'Pull', 'Legs', 'Arms']);
  expect(select).toHaveValue('100');
  await userEvent.selectOptions(select, 'Arms');
  await userEvent.click(logger.getByRole('button', { name: 'Change' }));

  expect(await logger.findByRole('heading', { name: 'Arms' })).toBeInTheDocument();
  expect(logger.getByRole('heading', { name: 'Bench Press' })).toBeInTheDocument();
  expect(chips(logger)).toEqual(['135 × 5']);
  const { body } = lastWrite(fake.fetch);
  expect(body).toMatchObject({ version: 1, day_id: 150 });
  expect(body.lines[0]!.sets).toHaveLength(1);
  expect(fake.sessions[0]!.turn_id).toBeNull();
});

async function pickAndStart(day: string) {
  renderToday();
  const card = within(await screen.findByRole('region', { name: /^Up next/ }));
  await userEvent.click(card.getByRole('button', { name: 'Pick another Day' }));
  await userEvent.click(within(card.getByRole('group', { name: 'Days on the rotation' })).getByRole('button', { name: day }));
  await userEvent.click(card.getByRole('button', { name: `Start ${day}` }));
  return within(await screen.findByRole('region', { name: 'Logger' }));
}

it('a picked Day taken off the rotation meanwhile is refused, and the logger reloads on the suggestion', async () => {
  const { routines, sessions } = fakeTodayApi([ppl3()]);
  const logger = await pickAndStart('Legs');
  routines[0]!.turns = ['Push', 'Pull']; // Legs dropped elsewhere

  await fill(logger, '225', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('not on the rotation');
  expect(await screen.findByRole('heading', { name: 'Push' })).toBeInTheDocument();
  expect(screen.queryByText(/^Suggested:/)).not.toBeInTheDocument();
  expect(sessions).toEqual([]);
});

it('the pick is used up by the Session it started', async () => {
  const fake = fakeTodayApi([ppl3()]);
  const logger = await pickAndStart('Legs');
  await fill(logger, '225', '5');
  await userEvent.click(logger.getByRole('button', { name: 'Save Set 1' }));
  await logger.findByRole('button', { name: 'Save Set 2' });

  await userEvent.click(logger.getByRole('button', { name: 'Delete Session…' }));
  await userEvent.click(within(logger.getByRole('group', { name: 'Delete Session' })).getByRole('button', { name: 'Delete Session' }));
  const card = within(await screen.findByRole('region', { name: /^Up next/ }));
  expect(card.getByText('Push')).toHaveClass('suggested-day');
  expect(card.queryByText(/^Suggested:/)).not.toBeInTheDocument();
  expect(fake.sessions).toEqual([]);
});

it('after Change Day, Up next follows the re-pinned Turn', async () => {
  const fake = fakeTodayApi([ppl3()]);
  const logger = await loggedPush(fake, ['135', '5']);
  await userEvent.click(logger.getByRole('button', { name: 'Change Day…' }));
  await userEvent.selectOptions(logger.getByLabelText('Day'), 'Pull');
  await userEvent.click(logger.getByRole('button', { name: 'Change' }));
  await logger.findByRole('heading', { name: 'Pull' });

  const calls = fake.fetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
  const changed = calls.findLastIndex((c) => c.startsWith('PUT /wolog/api/sessions/'));
  await waitFor(() =>
    expect(fake.fetch.mock.calls.slice(changed + 1).map(([url]) => url)).toContain('/wolog/api/up-next'),
  );
});
