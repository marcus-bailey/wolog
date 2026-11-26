import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from './App';
import { fakeRoutinesApi } from './routines/fakeApi';

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

const ppl = { id: 1, name: 'PPL', engaged: true };
const ul = { id: 2, name: 'Upper Lower', engaged: false };

async function openDrawer() {
  await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
  return screen.getByRole('navigation', { name: 'Menu' });
}

it('with no Routine, Today points the owner to create one', async () => {
  fakeRoutinesApi();
  renderAt('/');

  expect(await screen.findByText('No Routine yet. Create one to start logging.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('link', { name: 'Create a Routine' }));
  expect(screen.getByRole('heading', { name: 'Routines' })).toBeInTheDocument();
});

it('Today names the Engaged Routine and says its rotation is empty', async () => {
  fakeRoutinesApi([ppl, ul]);
  renderAt('/');

  expect(await screen.findByText('PPL')).toBeInTheDocument();
  expect(screen.getByText('Nothing is on the rotation.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Skip/ })).not.toBeInTheDocument();
});

it('the drawer goes to Today, History and Routines, and offers Sign out', async () => {
  fakeRoutinesApi([ppl]);
  renderAt('/');
  await screen.findByText('PPL');

  await userEvent.click(within(await openDrawer()).getByRole('link', { name: 'History' }));
  expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Menu' })).not.toBeInTheDocument();

  await userEvent.click(within(await openDrawer()).getByRole('link', { name: 'Routines' }));
  expect(screen.getByRole('heading', { name: 'Routines' })).toBeInTheDocument();

  const drawer = await openDrawer();
  expect(within(drawer).getByRole('link', { name: 'Sign out' })).toHaveAttribute('href', '/oauth2/sign_out');
  await userEvent.click(within(drawer).getByRole('link', { name: 'Today' }));
  expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
});

it('the drawer lists every Routine, marks the engaged one, and switches on tap', async () => {
  const { fetch } = fakeRoutinesApi([ppl, ul]);
  renderAt('/');
  await screen.findByText('PPL');

  const drawer = await openDrawer();
  const switches = within(within(drawer).getByRole('list', { name: 'Engaged Routine' })).getAllByRole('button');
  expect(switches.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
    ['●PPL', 'true'],
    ['Upper Lower', 'false'],
  ]);

  await userEvent.click(within(drawer).getByRole('button', { name: 'Upper Lower' }));
  expect(fetch).toHaveBeenLastCalledWith('/wolog/api/routines/2/engage', expect.objectContaining({ method: 'POST' }));
  expect(await screen.findByText('Upper Lower')).toBeInTheDocument(); // Today follows the switch
  expect(screen.queryByRole('navigation', { name: 'Menu' })).not.toBeInTheDocument();

  const again = await openDrawer();
  expect(within(again).getByRole('button', { name: 'Upper Lower' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(again).getByRole('button', { name: 'PPL' })).toHaveAttribute('aria-pressed', 'false');
});

it('the drawer shows a refused switch and keeps the engagement', async () => {
  const { fetch } = fakeRoutinesApi([ppl, ul]);
  renderAt('/');
  await screen.findByText('PPL');
  const drawer = await openDrawer();
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ code: 'not_found', message: 'That Routine no longer exists.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  await userEvent.click(within(drawer).getByRole('button', { name: 'Upper Lower' }));
  expect(await within(drawer).findByRole('alert')).toHaveTextContent('That Routine no longer exists.');
  expect(within(drawer).getByRole('button', { name: 'PPL' })).toHaveAttribute('aria-pressed', 'true');
});

it('an unknown path goes to Today', async () => {
  fakeRoutinesApi();
  renderAt('/nowhere');
  expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
});
