/** Civil dates (spec §7): the browser's local calendar, as YYYY-MM-DD. No time zones in the model. */

export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A civil date for reading, e.g. "Wed, Nov 26" (with the year when it isn't this year's). */
export function shownDate(date: string, today: string = localToday()): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Whole calendar days from civil date `from` to `to`. */
function daysBetween(from: string, to: string): number {
  const utc = (date: string) => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** How long before `to` the civil date `date` was, e.g. "yesterday", "3 days ago", "2 weeks ago". */
export function ago(date: string, to: string): string {
  const days = daysBetween(date, to);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (days <= 0) return 'the same day';
  if (days === 1) return 'yesterday';
  if (days < 14) return plural(days, 'day');
  if (days < 60) return plural(Math.floor(days / 7), 'week');
  if (days < 365) return plural(Math.min(11, Math.floor(days / 30)), 'month');
  return plural(Math.floor(days / 365), 'year');
}
