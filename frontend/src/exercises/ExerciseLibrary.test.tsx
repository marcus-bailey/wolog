import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExerciseLibrary } from './ExerciseLibrary';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

function namesIn(list: HTMLElement) {
  return within(list)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.name')?.textContent);
}

const squat = { id: 1, name: 'Squat', retired: false };
const bench = { id: 2, name: 'Bench Press', retired: false };

it('starts empty, creates an Exercise and lists it', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, []))
    .mockResolvedValueOnce(json(201, { id: 1, name: 'Bench Press', retired: false }));
  vi.stubGlobal('fetch', fetch);
  render(<ExerciseLibrary />);

  expect(await screen.findByText(/No Exercises yet/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('New Exercise'), '  Bench   Press ');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));

  const list = await screen.findByRole('list', { name: 'Exercises' });
  expect(namesIn(list)).toEqual(['Bench Press']);
  expect(screen.getByLabelText('New Exercise')).toHaveValue('');
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/exercises',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '  Bench   Press ' }) }),
  );
});

it('shows a refusal and keeps what was typed', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json(200, [{ id: 1, name: 'Squat', retired: false }]))
      .mockResolvedValueOnce(json(409, { code: 'name_taken', message: 'There is already an Exercise called “Squat”.' })),
  );
  render(<ExerciseLibrary />);

  await screen.findByText('Squat');
  await userEvent.type(screen.getByLabelText('New Exercise'), 'squat');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('There is already an Exercise called “Squat”.');
  expect(screen.getByLabelText('New Exercise')).toHaveValue('squat');
});

it('renames an Exercise in place', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, [bench, squat]))
    .mockResolvedValueOnce(json(200, { ...squat, name: 'Back Squat' }));
  vi.stubGlobal('fetch', fetch);
  render(<ExerciseLibrary />);

  await userEvent.click(await screen.findByRole('button', { name: 'Edit Squat' }));
  const input = screen.getByLabelText('Name');
  await userEvent.clear(input);
  await userEvent.type(input, 'Back Squat');
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

  expect(namesIn(await screen.findByRole('list', { name: 'Exercises' }))).toEqual(['Back Squat', 'Bench Press']);
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/exercises/1',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Back Squat' }) }),
  );
});

it('shows a refused rename on the row and keeps editing', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json(200, [bench, squat]))
      .mockResolvedValueOnce(
        json(409, { code: 'name_taken', message: 'There is already an Exercise called “Bench Press”.' }),
      ),
  );
  render(<ExerciseLibrary />);

  await userEvent.click(await screen.findByRole('button', { name: 'Edit Squat' }));
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'bench press');
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('There is already an Exercise called “Bench Press”.');
  expect(screen.getByLabelText('Name')).toHaveValue('bench press');
});

it('moves a Retired Exercise to the Retired section and back', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, [bench, squat]))
    .mockResolvedValueOnce(json(200, { ...squat, retired: true }))
    .mockResolvedValueOnce(json(200, squat));
  vi.stubGlobal('fetch', fetch);
  render(<ExerciseLibrary />);

  await userEvent.click(await screen.findByRole('button', { name: 'Edit Squat' }));
  await userEvent.click(screen.getByRole('button', { name: 'Retire' }));

  const retired = await screen.findByRole('list', { name: 'Retired Exercises' });
  expect(namesIn(retired)).toEqual(['Squat']);
  expect(namesIn(screen.getByRole('list', { name: 'Exercises' }))).toEqual(['Bench Press']);
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/exercises/1',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ retired: true }) }),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Edit Squat' }));
  await userEvent.click(screen.getByRole('button', { name: 'Un-retire' }));

  await vi.waitFor(() => expect(screen.queryByRole('list', { name: 'Retired Exercises' })).toBeNull());
  expect(namesIn(screen.getByRole('list', { name: 'Exercises' }))).toEqual(['Bench Press', 'Squat']);
});

it('deletes an unused Exercise', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, [bench, squat]))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  render(<ExerciseLibrary />);

  await userEvent.click(await screen.findByRole('button', { name: 'Edit Squat' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));

  await vi.waitFor(() => expect(screen.queryByText('Squat')).toBeNull());
  expect(namesIn(screen.getByRole('list', { name: 'Exercises' }))).toEqual(['Bench Press']);
  expect(fetch).toHaveBeenLastCalledWith('/wolog/api/exercises/1', expect.objectContaining({ method: 'DELETE' }));
});

it('shows why a used Exercise cannot be deleted', async () => {
  const message = '“Squat” is on a Line, so it can’t be deleted. Retire it to hide it from pickers instead.';
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json(200, [squat]))
      .mockResolvedValueOnce(json(409, { code: 'exercise_in_use', message })),
  );
  render(<ExerciseLibrary />);

  await userEvent.click(await screen.findByRole('button', { name: 'Edit Squat' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('button', { name: 'Retire' })).toBeInTheDocument();
});

it('asks before deleting, and keeps the Exercise when told to', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(200, [squat]));
  vi.stubGlobal('fetch', fetch);
  render(<ExerciseLibrary />);

  await userEvent.click(await screen.findByRole('button', { name: 'Edit Squat' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

  expect(screen.getByRole('group', { name: 'Confirm delete' })).toHaveTextContent('Delete “Squat” for good?');
  expect(fetch).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
  expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull();
  expect(screen.getByLabelText('Name')).toHaveValue('Squat');
  expect(fetch).toHaveBeenCalledTimes(1);
});
