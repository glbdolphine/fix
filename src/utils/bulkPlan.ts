// Turns a scan (which connection does each pasted ID belong to?) into a plan (what would happen to it?).
// Every bulk operation supplies only a `decide` function; the rows, counts and wording are shared, so
// all the bulk fills look and behave the same.
import type { LogEntry } from '../types';
import { MATCH_LABEL, ScanResult, ScanRow } from './bulkScan';

export type BulkStatus =
  | 'change'      // will be written
  | 'same'        // already in the wanted state
  | 'has_value'   // has a different value and "replace" is off
  | 'not_found'   // no connection with this ID
  | 'ambiguous'   // two or more connections share this ID
  | 'repeated'    // already in the list above
  | 'invalid'     // the pasted value is not valid for this field
  | 'no_value'    // more IDs than values
  | 'blocked';    // this connection cannot take the action

export type BulkCategory = 'ready' | 'skipped' | 'notfound' | 'error';

export const CATEGORY: Record<BulkStatus, BulkCategory> = {
  change: 'ready',
  same: 'skipped',
  has_value: 'skipped',
  repeated: 'skipped',
  not_found: 'notfound',
  ambiguous: 'error',
  invalid: 'error',
  no_value: 'error',
  blocked: 'error',
};

export interface BulkRow {
  n: number;
  token: string;        // as pasted
  log?: LogEntry;
  status: BulkStatus;
  now: string;          // what the connection has now
  next: string;         // what it will have
  value: string;        // the cleaned value to save (fill)
  replaces?: boolean;   // a ready row that overwrites an existing value
  note?: string;
  warn?: string;        // will still be written, but deserves a look
  fix?: string;         // something was tidied up on the way (the ID or the value)
}

export interface BulkPlan {
  rows: BulkRow[];
  ready: BulkRow[];
  total: number;
  matched: number;      // pasted IDs that found exactly one connection
  notFound: number;
  errors: number;
  skipped: number;
  fixed: number;
  warnings: number;
  counts: Record<BulkStatus, number>;
}

export type Decision = Pick<BulkRow, 'status' | 'now' | 'next'> & Partial<Pick<BulkRow, 'value' | 'replaces' | 'note' | 'warn' | 'fix'>>;
export type Decide = (log: LogEntry, row: ScanRow, index: number) => Decision;

const joinFix = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;

export function planFromScan(scan: ScanResult, decide: Decide): BulkPlan {
  const label = MATCH_LABEL[scan.by].short;
  const rows: BulkRow[] = scan.rows.map((r, i) => {
    const base = { n: r.n, token: r.raw, now: '', next: '', value: '', fix: r.fix };
    if (r.kind === 'not_found') {
      const note = !r.clean
        ? 'Nothing to look up on this line'
        : r.alt
          ? `Not an ${label}, but it is ${MATCH_LABEL[r.alt.by].short} of #${r.alt.log.logNo}`
          : `No connection with this ${label}`;
      return { ...base, status: 'not_found' as const, note };
    }
    if (r.kind === 'ambiguous') {
      return { ...base, status: 'ambiguous' as const, note: `${r.matches.length} connections share this ${label} (#${r.matches.map((m) => m.logNo).join(', #')})` };
    }
    if (r.kind === 'repeated') {
      return { ...base, status: 'repeated' as const, note: `Already on line ${r.firstAt} (the first one is used)` };
    }
    const d = decide(r.log!, r, i);
    return {
      ...base, log: r.log, status: d.status, now: d.now, next: d.next, value: d.value ?? '',
      replaces: d.replaces, note: d.note, warn: d.warn, fix: joinFix(r.fix, d.fix),
    };
  });

  const counts: Record<BulkStatus, number> = {
    change: 0, same: 0, has_value: 0, not_found: 0, ambiguous: 0, repeated: 0, invalid: 0, no_value: 0, blocked: 0,
  };
  for (const r of rows) counts[r.status]++;
  const cat = (c: BulkCategory) => rows.filter((r) => CATEGORY[r.status] === c).length;

  return {
    rows,
    ready: rows.filter((r) => r.status === 'change'),
    total: rows.length,
    matched: scan.matched,
    notFound: cat('notfound'),
    errors: cat('error'),
    skipped: cat('skipped'),
    fixed: rows.filter((r) => r.fix).length,
    warnings: rows.filter((r) => r.status === 'change' && r.warn).length,
    counts,
  };
}
