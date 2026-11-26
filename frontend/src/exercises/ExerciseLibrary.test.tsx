import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExerciseLibrary } from './ExerciseLibrary';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

it('starts empty, creates an Exercise and lists it', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, []))
    .mockResolvedValueOnce(json(201, { id: 1, name: 'Bench Press' }));
  vi.stubGlobal('fetch', fetch);
  render(<ExerciseLibrary />);

  expect(await screen.findByText(/No Exercises yet/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('New Exercise'), '  Bench   Press ');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));

  const list = await screen.findByRole('list', { name: 'Exercises' });
  expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Bench Press']);
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
      .mockResolvedValueOnce(json(200, [{ id: 1, name: 'Squat' }]))
      .mockResolvedValueOnce(json(409, { code: 'name_taken', message: 'There is already an Exercise called “Squat”.' })),
  );
  render(<ExerciseLibrary />);

  await screen.findByText('Squat');
  await userEvent.type(screen.getByLabelText('New Exercise'), 'squat');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('There is already an Exercise called “Squat”.');
  expect(screen.getByLabelText('New Exercise')).toHaveValue('squat');
});
