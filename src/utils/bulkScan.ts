// The one ID scanner behind every bulk fill (fill a field, foreman, term, forms received, bills received).
// Paste a list of NMS IDs / EDC numbers / connection numbers and it is checked against every connection
// straight away: matched, not matched, shared by two connections, repeated, or "found, but under another
// column". IDs it had to tidy up (Bangla digits, stray quotes, Excel's "55716.0", a leading 0...) are
// reported as fixes, so nothing is changed silently.
import type { LogEntry } from '../types';

export type MatchBy = 'nms' | 'edc' | 'logno';
export const MATCH_BY: MatchBy[] = ['nms', 'edc', 'logno'];

export const MATCH_LABEL: Record<MatchBy, { short: string; long: string }> = {
  nms: { short: 'NMS ID', long: 'NMS IDs' },
  edc: { short: 'EDC no.', long: 'EDC numbers' },
  logno: { short: 'Conn. no.', long: 'connection numbers' },
};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const bnToEn = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00A0]/g;

/** An ID as pasted -> the form we search with. */
export function cleanToken(raw: string): string {
  let t = bnToEn(raw.replace(INVISIBLE, ' ').trim());
  t = t.replace(/^["'“”‘’`#([]+/, '').replace(/["'“”‘’`)\]]+$/, ''); // wrapping quotes / brackets / "#"
  t = t.replace(/[.:]+$/, '');                                        // trailing punctuation
  t = t.replace(/^(\d+)\.0+$/, '$1');                                 // Excel turned 55716 into 55716.0
  return t.trim();
}

/** Comparison key. NMS IDs are compared as text; EDC / connection numbers ignore leading zeros (1 = 01 = ০১). */
export function idKey(clean: string, by: MatchBy): string {
  const t = clean.toLowerCase();
  if (by === 'nms') return t;
  const compact = t.replace(/\s+/g, '');
  return /^\d+$/.test(compact) ? compact.replace(/^0+(?=\d)/, '') : compact;
}

const valueOf = (l: LogEntry, by: MatchBy): string =>
  by === 'nms' ? l.nmsId : by === 'edc' ? (l.edcNo ?? '') : String(l.logNo ?? '');

export type LogIndexes = Record<MatchBy, Map<string, LogEntry[]>>;

/** One lookup table per column, built once per list of connections. Deleted connections never match. */
export function buildIndexes(logs: LogEntry[]): LogIndexes {
  const out: LogIndexes = { nms: new Map(), edc: new Map(), logno: new Map() };
  for (const l of logs) {
    if (l.deletedAt) continue;
    for (const by of MATCH_BY) {
      const v = valueOf(l, by);
      if (!v || !String(v).trim()) continue;
      const k = idKey(cleanToken(String(v)), by);
      if (!k) continue;
      const list = out[by].get(k);
      if (list) list.push(l); else out[by].set(k, [l]);
    }
  }
  return out;
}

export interface PastedId { raw: string; extra: boolean }

/**
 * One ID per line (or several on a line, separated by spaces / commas). A line pasted from two Excel
 * columns (tab separated) contributes its first cell only; `extra` marks that it had more.
 */
export function parseIds(text: string): PastedId[] {
  const out: PastedId[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.includes('\t')) {
      const cells = line.split('\t').map((c) => c.trim());
      const first = cells.find(Boolean);
      if (first) out.push({ raw: first, extra: cells.filter(Boolean).length > 1 });
      continue;
    }
    for (const t of line.split(/[\s,;|]+/)) if (t.trim()) out.push({ raw: t.trim(), extra: false });
  }
  return out;
}

/** Lines that hold "ID <tab> value" (an Excel copy of two columns) -> the two lists. */
export function splitPairs(text: string): { ids: string; values: string } | null {
  const ids: string[] = [];
  const values: string[] = [];
  let pairs = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('\t').map((c) => c.trim());
    ids.push(cells[0] || '');
    values.push(cells.slice(1).filter(Boolean).join(' '));
    if (cells.length > 1 && cells.slice(1).some(Boolean)) pairs++;
  }
  return pairs ? { ids: ids.join('\n'), values: values.join('\n') } : null;
}

export type ScanKind = 'matched' | 'not_found' | 'ambiguous' | 'repeated';

export interface ScanRow {
  n: number;                 // 1-based position in the pasted list
  raw: string;               // exactly as pasted
  clean: string;             // what was searched for
  kind: ScanKind;
  log?: LogEntry;            // the connection (kind === 'matched')
  matches: LogEntry[];       // every connection carrying this ID
  firstAt?: number;          // for 'repeated': the line it first appeared on
  fix?: string;              // the ID was tidied up
  alt?: { by: MatchBy; log: LogEntry }; // not found here, but exactly one connection has it in another column
}

export interface ScanResult {
  by: MatchBy;
  rows: ScanRow[];
  total: number;
  matched: number;
  notFound: number;
  ambiguous: number;
  repeated: number;
  fixed: number;
  extraColumns: boolean;     // some lines had more than one column
  alt: Record<MatchBy, number>; // how many not-found IDs would match under each other column
}

function idFix(raw: string, clean: string, by: MatchBy): string | undefined {
  const base = raw.replace(INVISIBLE, ' ').trim();
  if (clean && clean !== base) return `Read “${base}” as ${clean}`;
  if (by !== 'nms' && /^0+\d/.test(clean)) return 'Leading zero ignored';
  return undefined;
}

export function scanIds(text: string, idx: LogIndexes, by: MatchBy): ScanResult {
  const pasted = parseIds(text);
  const seen = new Map<string, number>();
  const alt: Record<MatchBy, number> = { nms: 0, edc: 0, logno: 0 };
  let matched = 0, notFound = 0, ambiguous = 0, repeated = 0, fixed = 0;

  const rows: ScanRow[] = pasted.map((p, i) => {
    const n = i + 1;
    const clean = cleanToken(p.raw);
    const key = idKey(clean, by);
    const fix = idFix(p.raw, clean, by);
    if (fix) fixed++;
    const base = { n, raw: p.raw, clean, fix, matches: [] as LogEntry[] };

    if (!key) { notFound++; return { ...base, kind: 'not_found' as const }; }
    const firstAt = seen.get(key);
    if (firstAt !== undefined) { repeated++; return { ...base, kind: 'repeated' as const, firstAt }; }
    seen.set(key, n);

    const matches = idx[by].get(key) || [];
    if (matches.length === 1) { matched++; return { ...base, kind: 'matched' as const, matches, log: matches[0] }; }
    if (matches.length > 1) { ambiguous++; return { ...base, kind: 'ambiguous' as const, matches }; }

    notFound++;
    let hit: ScanRow['alt'];
    for (const other of MATCH_BY) {
      if (other === by) continue;
      const m = idx[other].get(idKey(clean, other));
      if (m && m.length === 1) { hit = { by: other, log: m[0] }; alt[other]++; break; }
    }
    return { ...base, kind: 'not_found' as const, alt: hit };
  });

  return {
    by, rows, total: rows.length, matched, notFound, ambiguous, repeated, fixed,
    extraColumns: pasted.some((p) => p.extra), alt,
  };
}
