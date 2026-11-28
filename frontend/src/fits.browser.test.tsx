import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from './App';
import { localToday } from './dates';
import { fakeTodayApi, type FakeRoutine } from './today/fakeApi';
import './index.css';

/*
 * Phone-first (spec §8, §10 item 3): every screen fits a phone's width, with no sideways scroll.
 * These render the screens with the app's CSS in Chromium at phone widths, with names long enough
 * to have to wrap.
 */

const LONG_ROUTINE = 'PowerbuildingHypertrophyBlockNumberTwo';
const LONG_DAY = 'PosteriorChainAndHamstrings';
const LONG_EXERCISE = 'SingleArmDumbbellRomanianDeadlift';

const routine = (): FakeRoutine => ({
  id: 1,
  name: LONG_ROUTINE,
  engaged: true,
  turns: [LONG_DAY, 'Push'],
  skips: [],
  lines: { [LONG_DAY]: [LONG_EXERCISE, 'Rows', 'Face Pulls', 'Hammer Curls'], Push: ['Bench Press'] },
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

/** What sticks out past the right edge, as `tag.class`, for the failure message. */
function overflowing(): string[] {
  const width = document.documentElement.clientWidth;
  return [...document.body.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > width + 0.5)
    .filter((el) => !el.closest('.line-strip')) // the Lines strip scrolls sideways on its own
    .map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').join('.')}` : ''}`);
}

function expectFits() {
  expect(overflowing()).toEqual([]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}

// 320px is the narrowest phone in use; 390px a common one.
describe.each([320, 390])('at %ipx wide', (width) => {
  beforeEach(async () => {
    await page.viewport(width, 700);
  });

  it('Today fits', async () => {
    fakeTodayApi([routine()]);
    renderAt('/');
    await screen.findByRole('button', { name: `Start ${LONG_DAY}` });
    expectFits();
  });

  it('the Day picker fits, with long Day names wrapping inside their chips', async () => {
    // The suggestion, Push, isn't offered; the other Day's name is wider than the card.
    fakeTodayApi([{ ...routine(), turns: ['Push', `${LONG_DAY}AndGlutes`] }]);
    renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Pick another Day' }));
    const picker = await screen.findByRole('group', { name: 'Days on the rotation' });
    expectFits();
    for (const chip of within(picker).getAllByRole('button')) expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
  });

  it('the logger fits throughout a Session: Sets, the Set sheet, + Line, Change Day, and Delete', async () => {
    fakeTodayApi([routine()]);
    renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: `Start ${LONG_DAY}` }));
    const logger = within(await screen.findByRole('region', { name: 'Logger' }));
    expectFits();

    // A long Line name ends in … on its chip, inside the pill, and its Set count still shows.
    const chip = logger.getByRole('button', { name: `${LONG_EXERCISE} 0` });
    const name = chip.querySelector('.chip-name')!;
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(chip.getBoundingClientRect().right);
    expect(chip.querySelector('.count')!.getBoundingClientRect().right).toBeLessThanOrEqual(
      chip.getBoundingClientRect().right,
    );
    expect(chip).toHaveAttribute('title', LONG_EXERCISE);

    for (const n of [1, 2, 3]) {
      await userEvent.clear(logger.getByLabelText('Weight (lb)'));
      await userEvent.type(logger.getByLabelText('Weight (lb)'), '1225.5');
      await userEvent.clear(logger.getByLabelText('Reps'));
      await userEvent.type(logger.getByLabelText('Reps'), '12');
      await userEvent.click(logger.getByRole('button', { name: `Save Set ${n}` }));
      await logger.findByRole('button', { name: `Save Set ${n + 1}` });
    }
    expectFits();

    const sets = within(logger.getByRole('list', { name: 'Today’s Sets' }));
    await userEvent.click(sets.getAllByRole('button')[0]!);
    expectFits();

    await userEvent.click(logger.getByRole('button', { name: '+ Line' }));
    expectFits();

    await userEvent.click(logger.getByRole('button', { name: /Change Day/ }));
    expectFits();

    await userEvent.click(logger.getByRole('button', { name: 'Delete Session…' }));
    await logger.findByRole('group', { name: 'Delete Session' });
    expectFits();
  });

  it('the Routines list fits', async () => {
    fakeTodayApi([routine(), { ...routine(), id: 2, name: `${LONG_ROUTINE}Copy`, engaged: false }]);
    renderAt('/routines');
    await screen.findByRole('link', { name: LONG_ROUTINE });
    expectFits();
  });

  it('Routine detail fits, with a Day open', async () => {
    fakeTodayApi([routine()]);
    renderAt('/routines/1');
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(LONG_DAY), expanded: false }));
    await screen.findByText(LONG_EXERCISE);
    expectFits();
  });

  it('the Exercise library fits', async () => {
    const { fetch } = fakeTodayApi([routine()]);
    await fetch('/wolog/api/routines/1'); // the fake learns its Exercises from the Days' Lines
    renderAt('/exercises');
    await screen.findAllByText(LONG_EXERCISE);
    expectFits();
  });

  it('History fits', async () => {
    fakeTodayApi(
      [{ ...routine(), skips: [{ id: 9, date: '2026-01-01', turn: 1 }] }],
      [
        {
          id: 1,
          date: localToday(),
          routine: { id: 1, name: LONG_ROUTINE },
          day: { id: 100, name: LONG_DAY },
          turn_id: 100,
          version: 1,
          lines: [],
        },
      ],
    );
    renderAt('/history');
    await screen.findAllByText(new RegExp(LONG_DAY));
    expectFits();
  });

  it('the drawer fits', async () => {
    fakeTodayApi([routine()]);
    renderAt('/');
    await screen.findByRole('button', { name: `Start ${LONG_DAY}` });
    await userEvent.click(screen.getByRole('button', { name: /menu/i }));
    expectFits();
  });
});
