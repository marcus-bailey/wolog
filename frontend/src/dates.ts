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
