import { expect, it } from 'vitest';
import { ago } from './dates';

it('says how long before a date another civil date was', () => {
  expect(ago('2026-11-26', '2026-11-27')).toBe('yesterday');
  expect(ago('2026-11-24', '2026-11-27')).toBe('3 days ago');
  expect(ago('2026-11-14', '2026-11-27')).toBe('13 days ago');
  expect(ago('2026-11-13', '2026-11-27')).toBe('2 weeks ago');
  expect(ago('2026-09-28', '2026-11-27')).toBe('2 months ago');
  expect(ago('2025-12-01', '2026-11-27')).toBe('11 months ago');
  expect(ago('2025-11-27', '2026-11-27')).toBe('1 year ago');
  // Across a change of clocks it still counts calendar days.
  expect(ago('2026-03-07', '2026-03-09')).toBe('2 days ago');
});
