import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { messageOf } from '../api';
import { localToday, shownDate } from '../dates';
import { getHistory, type HistoryRow } from './api';

/**
 * History (spec §4.9, §5; HST-1, HST-2): one list of Sessions and Skips across all Routines, newest
 * first, by current names. A Session row shows its date, Routine and Day and opens the Session in the
 * logger; a Skip row shows its date, Routine and the skipped Day, and reads as a pass. Rest dates
 * have no row.
 */
export function History() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(localToday);
  useEffect(() => {
    let current = true;
    getHistory().then(
      (found) => current && setRows(found),
      (e: unknown) => current && setError(messageOf(e)),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <main className="screen">
      <h1>History</h1>
      {error ? (
        <p role="alert" className="refusal">
          {error}
        </p>
      ) : !rows ? (
        <p className="quiet">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="quiet">No Sessions or Skips yet.</p>
      ) : (
        <ol className="list history" aria-label="Sessions and Skips">
          {rows.map((r) =>
            r.kind === 'session' ? (
              <li key={`session-${r.id}`} className="history-row">
                <Link to={`/?on=${r.date}`}>
                  <span className="history-date">{shownDate(r.date, today)}</span>
                  <span className="history-day">{r.day.name}</span>
                  <span className="quiet">{r.routine.name}</span>
                </Link>
              </li>
            ) : (
              <li key={`skip-${r.id}`} className="history-row skip">
                <span className="history-date">{shownDate(r.date, today)}</span>
                <span className="history-day">Skipped {r.day.name}</span>
                <span className="quiet">{r.routine.name}</span>
              </li>
            ),
          )}
        </ol>
      )}
    </main>
  );
}
