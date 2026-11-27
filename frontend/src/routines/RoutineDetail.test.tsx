import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { RoutineDetail } from './RoutineDetail';
import type { Exercise } from '../exercises/api';
import type { Day, Turn } from './api';

afterEach(() => vi.unstubAllGlobals());

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/** The Day routes of the API, in memory, with its rules for names and Lines. */
function fakeApi(exercises: Exercise[] = [], days: Day[] = [], rotation?: Turn[]) {
  let nextId = 100;
  const state = {
    days: structuredClone(days),
    exercises: structuredClone(exercises),
    rotation: rotation ?? days.map((d) => ({ id: d.id + 1000, day_id: d.id })),
    /** The next Turn; none unless a test sets it. */
    next: undefined as number | undefined,
  };
  const detail = () => ({
    id: 1,
    name: 'PPL',
    engaged: true,
    days: state.days,
    rotation: state.rotation,
    next_turn_id: state.next ?? null,
  });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/wolog/api/', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (method === 'GET' && path === 'routines/1') {
      return json(200, detail());
    }
    if (path === 'routines/1/turns' && method === 'POST') {
      state.rotation.push({ id: nextId++, day_id: body.day_id as number });
      return json(200, detail());
    }
    if (path === 'routines/1/turns' && method === 'PUT') {
      const ids = body.turn_ids as number[];
      state.rotation = ids.map((id) => state.rotation.find((t) => t.id === id)!);
      return json(200, detail());
    }
    const turn = /^routines\/1\/turns\/(\d+)$/.exec(path);
    if (turn && method === 'DELETE') {
      state.rotation = state.rotation.filter((t) => t.id !== Number(turn[1]));
      return json(200, detail());
    }
    const onDay = /^days\/(\d+)\/(drop|put-back)$/.exec(path);
    if (onDay) {
      const dayId = Number(onDay[1]);
      if (onDay[2] === 'drop') state.rotation = state.rotation.filter((t) => t.day_id !== dayId);
      else state.rotation.push({ id: nextId++, day_id: dayId });
      return json(200, detail());
    }
    if (method === 'GET' && path === 'exercises?retired=false') return json(200, state.exercises.filter((e) => !e.retired));
    if (method === 'POST' && path === 'routines/1/days') {
      const name = norm(body.name as string);
      const other = state.days.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (other) return json(409, { code: 'name_taken', message: `There is already a Day called “${other.name}” in this Routine.` });
      const day = { id: nextId++, name, lines: [] };
      state.days.push(day);
      state.rotation.push({ id: nextId++, day_id: day.id });
      return json(201, day);
    }
    const m = /^days\/(\d+)(\/lines)?(?:\/(\d+))?$/.exec(path);
    const day = m && state.days.find((d) => d.id === Number(m[1]));
    if (!day) return json(404, { code: 'not_found', message: 'That Day no longer exists.' });
    if (method === 'PATCH') {
      day.name = norm(body.name as string);
      return json(200, day);
    }
    if (method === 'POST') {
      const name = norm(body.name as string);
      let exercise = state.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (exercise?.retired) {
        return json(409, { code: 'name_retired', message: `“${exercise.name}” is a Retired Exercise. Un-retire it to use it again.` });
      }
      if (!exercise) {
        exercise = { id: nextId++, name, retired: false };
        state.exercises.push(exercise);
      }
      day.lines.push({ id: nextId++, exercise });
      return json(201, day);
    }
    if (method === 'PUT') {
      const ids = body.line_ids as number[];
      day.lines = ids.map((id) => day.lines.find((l) => l.id === id)!);
      return json(200, day);
    }
    if (method === 'DELETE') {
      day.lines = day.lines.filter((l) => l.id !== Number(m[3]));
      return json(200, day);
    }
    return json(405, {});
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, state };
}

function renderDetail() {
  render(
    <MemoryRouter initialEntries={['/routines/1']}>
      <Routes>
        <Route path="/routines/:routineId" element={<RoutineDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const bench = { id: 1, name: 'Bench Press', retired: false };
const fly = { id: 2, name: 'Fly', retired: false };
const squat = { id: 3, name: 'Squat', retired: true };

function lineNames(dayName: string) {
  return within(screen.getByRole('list', { name: `Lines of ${dayName}` }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.name')?.textContent);
}

async function expand(dayName: string) {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${dayName}`) }));
}

it('creates Days at the bottom, each starting with no Lines', async () => {
  const { fetch } = fakeApi();
  renderDetail();

  expect(await screen.findByText('No Days yet. Create the first one below.')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('New Day'), 'Push');
  await userEvent.click(screen.getByRole('button', { name: 'Create Day' }));
  await userEvent.type(screen.getByLabelText('New Day'), 'Pull');
  await userEvent.click(screen.getByRole('button', { name: 'Create Day' }));

  const days = await screen.findByRole('list', { name: 'Days' });
  await within(days).findByText('Pull');
  expect(within(days).getAllByRole('button').map((b) => b.textContent)).toEqual(['Push0 Lines', 'Pull0 Lines']);
  expect(screen.getByLabelText('New Day')).toHaveValue('');
  expect(fetch).toHaveBeenCalledWith(
    '/wolog/api/routines/1/days',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Push' }) }),
  );
});

it('shows a Day name collision', async () => {
  fakeApi([], [{ id: 10, name: 'Push', lines: [] }]);
  renderDetail();
  await screen.findByRole('button', { name: /^Push/ });

  await userEvent.type(screen.getByLabelText('New Day'), 'push');
  await userEvent.click(screen.getByRole('button', { name: 'Create Day' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('There is already a Day called “Push” in this Routine.');
  expect(screen.getByLabelText('New Day')).toHaveValue('push');
});

it('adds Lines by name: attaching a live Exercise, creating a new one, and repeating one', async () => {
  const { fetch, state } = fakeApi([bench, squat], [{ id: 10, name: 'Push', lines: [] }]);
  renderDetail();
  await expand('Push');

  const input = screen.getByLabelText('Add an Exercise');
  await userEvent.type(input, 'bench press');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(await screen.findByRole('list', { name: 'Lines of Push' })).toBeInTheDocument();
  expect(input).toHaveValue('');

  await userEvent.type(input, 'Dip');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  await userEvent.type(input, 'Bench Press');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));

  await screen.findByRole('button', { name: 'Remove Bench Press (Line 3)' });
  expect(lineNames('Push')).toEqual(['Bench Press', 'Dip', 'Bench Press']);
  expect(state.exercises.map((e) => e.name)).toEqual(['Bench Press', 'Squat', 'Dip']);
  expect(fetch).toHaveBeenCalledWith(
    '/wolog/api/days/10/lines',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Dip' }) }),
  );
});

it('the picker offers live Exercises only, including ones just created on a Line', async () => {
  fakeApi([bench, squat], [{ id: 10, name: 'Push', lines: [] }]);
  renderDetail();
  await expand('Push');

  const options = () => Array.from(document.querySelectorAll('#exercise-picks option')).map((o) => o.getAttribute('value'));
  expect(screen.getByLabelText('Add an Exercise')).toHaveAttribute('list', 'exercise-picks');
  expect(options()).toEqual(['Bench Press']);

  await userEvent.type(screen.getByLabelText('Add an Exercise'), 'Dip');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  await screen.findByRole('list', { name: 'Lines of Push' });
  expect(options()).toEqual(['Bench Press', 'Dip']);
});

it('refuses a Retired Exercise’s name, pointing to it', async () => {
  fakeApi([squat], [{ id: 10, name: 'Legs', lines: [] }]);
  renderDetail();
  await expand('Legs');

  await userEvent.type(screen.getByLabelText('Add an Exercise'), 'squat');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('“Squat” is a Retired Exercise. Un-retire it to use it again.');
  expect(screen.getByLabelText('Add an Exercise')).toHaveValue('squat');
});

it('marks a Line whose Exercise was Retired later; the Line stays', async () => {
  fakeApi([], [{ id: 10, name: 'Legs', lines: [{ id: 20, exercise: squat }] }]);
  renderDetail();
  await expand('Legs');
  expect(lineNames('Legs')).toEqual(['Squat · Retired']);
});

it('reorders Lines with ↑ / ↓ and removes them with ✕', async () => {
  const { fetch } = fakeApi(
    [],
    [
      {
        id: 10,
        name: 'Push',
        lines: [
          { id: 20, exercise: bench },
          { id: 21, exercise: fly },
          { id: 22, exercise: bench },
        ],
      },
    ],
  );
  renderDetail();
  await expand('Push');

  expect(screen.getByRole('button', { name: 'Move Bench Press (Line 1) up' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Bench Press (Line 3) down' })).toBeDisabled();

  await userEvent.click(screen.getByRole('button', { name: 'Move Fly (Line 2) up' }));
  await screen.findByRole('button', { name: 'Move Fly (Line 1) down' });
  expect(lineNames('Push')).toEqual(['Fly', 'Bench Press', 'Bench Press']);
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/days/10/lines',
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ line_ids: [21, 20, 22] }) }),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Move Fly (Line 1) down' }));
  await screen.findByRole('button', { name: 'Move Fly (Line 2) down' });
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/days/10/lines',
    expect.objectContaining({ body: JSON.stringify({ line_ids: [20, 21, 22] }) }),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Remove Bench Press (Line 3)' }));
  await screen.findByText('2 Lines');
  expect(lineNames('Push')).toEqual(['Bench Press', 'Fly']);
  expect(fetch).toHaveBeenLastCalledWith('/wolog/api/days/10/lines/22', expect.objectContaining({ method: 'DELETE' }));
});

it('renames a Day', async () => {
  const { fetch } = fakeApi([], [{ id: 10, name: 'Push', lines: [] }]);
  renderDetail();
  await expand('Push');

  await userEvent.click(screen.getByRole('button', { name: 'Rename Push' }));
  const input = screen.getByLabelText('Day name');
  await userEvent.clear(input);
  await userEvent.type(input, 'Push A');
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

  expect(await screen.findByRole('button', { name: /^Push A/ })).toBeInTheDocument();
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/days/10',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Push A' }) }),
  );
});

it('reloads the Routine when the Day’s Lines changed elsewhere', async () => {
  const { fetch, state } = fakeApi([], [{ id: 10, name: 'Push', lines: [{ id: 20, exercise: bench }, { id: 21, exercise: fly }] }]);
  renderDetail();
  await expand('Push');
  state.days[0]?.lines.push({ id: 23, exercise: fly });
  fetch.mockResolvedValueOnce(
    json(409, { code: 'lines_changed', message: 'The Day’s Lines changed since you loaded them. Reload and try again.' }),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Move Fly (Line 2) up' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The Day’s Lines changed since you loaded them.');
  await screen.findByText('3 Lines');
});

it('says when the Routine no longer exists', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(404, { code: 'not_found', message: 'That Routine no longer exists.' })),
  );
  renderDetail();
  expect(await screen.findByRole('alert')).toHaveTextContent('That Routine no longer exists.');
});

// The rotation (DAY-3)

const push = { id: 10, name: 'Push', lines: [] };
const pull = { id: 11, name: 'Pull', lines: [] };
const legs = { id: 12, name: 'Legs', lines: [] };

function rotationNames() {
  return within(screen.getByRole('list', { name: 'Rotation' }))
    .getAllByRole('listitem')
    .map((li) => `${li.querySelector('.position')?.textContent} ${li.querySelector('.name')?.textContent}`);
}

it('shows the rotation as numbered Turns naming their Days', async () => {
  fakeApi([], [push, pull, legs], [
    { id: 1, day_id: 10 },
    { id: 2, day_id: 11 },
    { id: 3, day_id: 10 },
    { id: 4, day_id: 12 },
  ]);
  renderDetail();
  await screen.findByRole('list', { name: 'Rotation' });
  expect(rotationNames()).toEqual(['1 Push', '2 Pull', '3 Push', '4 Legs']);
});

it('a new Day appears at the end of the rotation', async () => {
  fakeApi([], [push]);
  renderDetail();
  await screen.findByRole('list', { name: 'Rotation' });
  await userEvent.type(screen.getByLabelText('New Day'), 'Pull');
  await userEvent.click(screen.getByRole('button', { name: 'Create Day' }));
  await screen.findByText('2');
  expect(rotationNames()).toEqual(['1 Push', '2 Pull']);
});

it('adds a Turn for a Day at the end, repeats allowed', async () => {
  const { fetch } = fakeApi([], [push, pull]);
  renderDetail();
  await screen.findByRole('list', { name: 'Rotation' });
  expect(screen.getByRole('button', { name: 'Add Turn' })).toBeDisabled();

  await userEvent.selectOptions(screen.getByLabelText('Add a Turn for…'), 'Push');
  await userEvent.click(screen.getByRole('button', { name: 'Add Turn' }));
  await screen.findByText('3');
  expect(rotationNames()).toEqual(['1 Push', '2 Pull', '3 Push']);
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/routines/1/turns',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ day_id: 10 }) }),
  );
});

it('reorders Turns with ↑ / ↓, keeping their identity, and removes one with ✕', async () => {
  const { fetch } = fakeApi([], [push, pull, legs]);
  renderDetail();
  await screen.findByRole('list', { name: 'Rotation' });
  expect(screen.getByRole('button', { name: 'Move Turn 1, Push up' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Turn 3, Legs down' })).toBeDisabled();

  await userEvent.click(screen.getByRole('button', { name: 'Move Turn 3, Legs up' }));
  await screen.findByRole('button', { name: 'Move Turn 2, Legs up' });
  expect(rotationNames()).toEqual(['1 Push', '2 Legs', '3 Pull']);
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/routines/1/turns',
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ turn_ids: [1010, 1012, 1011] }) }),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Remove Turn 1, Push' }));
  await screen.findByRole('button', { name: 'Remove Turn 1, Legs' });
  expect(rotationNames()).toEqual(['1 Legs', '2 Pull']);
  expect(fetch).toHaveBeenLastCalledWith('/wolog/api/routines/1/turns/1010', expect.objectContaining({ method: 'DELETE' }));
});

it('the rotation may be empty', async () => {
  fakeApi([], [push], []);
  renderDetail();
  expect(await screen.findByText('Nothing is on the rotation. Add a Turn for a Day below.')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Rotation' })).not.toBeInTheDocument();
});

it('Drop takes a Day off the rotation and Put back adds one Turn at the end', async () => {
  const { fetch } = fakeApi([], [push, pull], [
    { id: 1, day_id: 10 },
    { id: 2, day_id: 11 },
    { id: 3, day_id: 10 },
  ]);
  renderDetail();
  await expand('Push');

  await userEvent.click(screen.getByRole('button', { name: 'Drop Push from the rotation' }));
  await screen.findByRole('button', { name: 'Put Push back on the rotation' });
  expect(rotationNames()).toEqual(['1 Pull']);
  expect(screen.getByRole('button', { name: /^Push/ })).toHaveTextContent('off the rotation');
  expect(fetch).toHaveBeenLastCalledWith('/wolog/api/days/10/drop', expect.objectContaining({ method: 'POST' }));

  await userEvent.click(screen.getByRole('button', { name: 'Put Push back on the rotation' }));
  await screen.findByRole('button', { name: 'Drop Push from the rotation' });
  expect(rotationNames()).toEqual(['1 Pull', '2 Push']);
  expect(screen.getByRole('button', { name: /^Push/ })).not.toHaveTextContent('off the rotation');
  expect(fetch).toHaveBeenLastCalledWith('/wolog/api/days/10/put-back', expect.objectContaining({ method: 'POST' }));
});

it('reloads the Routine when the rotation changed elsewhere', async () => {
  const { fetch, state } = fakeApi([], [push, pull]);
  renderDetail();
  await screen.findByRole('list', { name: 'Rotation' });
  state.rotation.push({ id: 99, day_id: 10 });
  fetch.mockResolvedValueOnce(
    json(409, { code: 'rotation_changed', message: 'The rotation changed since you loaded it. Reload and try again.' }),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Move Turn 2, Pull up' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The rotation changed since you loaded it.');
  await screen.findByRole('button', { name: 'Remove Turn 3, Push' });
});

it('marks the next Turn', async () => {
  const { state } = fakeApi([], [push, pull, legs]);
  state.next = 1011;
  renderDetail();
  await screen.findByRole('list', { name: 'Rotation' });
  expect(rotationNames()).toEqual(['1 Push', '2 Pull · next', '3 Legs']);
});
