import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { RoutineList } from './RoutineList';
import { RoutinesProvider } from './RoutinesContext';
import { fakeRoutinesApi } from './fakeApi';

afterEach(() => vi.unstubAllGlobals());

function renderList() {
  render(
    <MemoryRouter>
      <RoutinesProvider>
        <RoutineList />
      </RoutinesProvider>
    </MemoryRouter>,
  );
}

function rows() {
  return within(screen.getByRole('list', { name: 'Routines' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.name')?.textContent);
}

it('creates the first Routine engaged and later ones not', async () => {
  const { fetch } = fakeRoutinesApi();
  renderList();

  expect(await screen.findByText(/No Routines yet/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('New Routine'), '  Push  Pull Legs ');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/routines',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '  Push  Pull Legs ' }) }),
  );
  expect(await screen.findByText('● Engaged')).toBeInTheDocument();
  expect(screen.getByLabelText('New Routine')).toHaveValue('');

  await userEvent.type(screen.getByLabelText('New Routine'), 'Full Body');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(await screen.findByRole('button', { name: 'Engage Full Body' })).toBeInTheDocument();
  expect(rows()).toEqual(['Full Body', 'Push Pull Legs ● Engaged']);
  expect(screen.queryByRole('button', { name: 'Engage Push Pull Legs' })).not.toBeInTheDocument();
});

it('shows a name collision and keeps what was typed', async () => {
  fakeRoutinesApi([{ id: 1, name: 'PPL', engaged: true }]);
  renderList();
  await screen.findByText('PPL');

  await userEvent.type(screen.getByLabelText('New Routine'), 'ppl');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('There is already a Routine called “PPL”.');
  expect(screen.getByLabelText('New Routine')).toHaveValue('ppl');
});

it('offers Engage on every other Routine and moves the mark when tapped', async () => {
  fakeRoutinesApi([
    { id: 1, name: 'PPL', engaged: true },
    { id: 2, name: 'Upper Lower', engaged: false },
    { id: 3, name: 'Full Body', engaged: false },
  ]);
  renderList();
  await screen.findByText('PPL');
  expect(screen.getAllByRole('button', { name: /^Engage / })).toHaveLength(2);

  await userEvent.click(screen.getByRole('button', { name: 'Engage Upper Lower' }));
  expect(await screen.findByRole('button', { name: 'Engage PPL' })).toBeInTheDocument();
  expect(rows()).toEqual(['Full Body', 'PPL', 'Upper Lower ● Engaged']);
});

it('renames a Routine, keeping its engagement', async () => {
  const { fetch } = fakeRoutinesApi([
    { id: 1, name: 'PPL', engaged: true },
    { id: 2, name: 'Upper Lower', engaged: false },
  ]);
  renderList();

  await userEvent.click(await screen.findByRole('button', { name: 'Rename PPL' }));
  const input = screen.getByLabelText('Name');
  await userEvent.clear(input);
  await userEvent.type(input, 'Push Pull Legs');
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

  expect(await screen.findByText('Push Pull Legs')).toBeInTheDocument();
  expect(rows()).toEqual(['Push Pull Legs ● Engaged', 'Upper Lower']);
  expect(fetch).toHaveBeenLastCalledWith(
    '/wolog/api/routines/1',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Push Pull Legs' }) }),
  );
});

it('shows a refused rename and keeps the form open', async () => {
  fakeRoutinesApi([
    { id: 1, name: 'PPL', engaged: true },
    { id: 2, name: 'Upper Lower', engaged: false },
  ]);
  renderList();

  await userEvent.click(await screen.findByRole('button', { name: 'Rename PPL' }));
  const input = screen.getByLabelText('Name');
  await userEvent.clear(input);
  await userEvent.type(input, 'upper lower');
  await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('There is already a Routine called “Upper Lower”.');
  expect(screen.getByLabelText('Name')).toHaveValue('upper lower');
});

it('links to the Exercise library', async () => {
  fakeRoutinesApi();
  renderList();
  expect(await screen.findByRole('link', { name: 'Exercise library' })).toHaveAttribute('href', '/exercises');
});
