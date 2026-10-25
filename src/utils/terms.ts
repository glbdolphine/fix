// Shared bits for the "term" marking (First Term, Second Term, ...) used by the Connection Records page.
import type { LogEntry } from '../types';

export const TERM_PRESETS = ['First Term', 'Second Term', 'Third Term', 'Fourth Term'];
/** Filter value meaning "connections that have no term yet". */
export const TERM_NONE = '__none__';

/** Presets first, then any custom term that exists in the data. */
export function termList(counts: Record<string, number>): string[] {
  return [...new Set([...TERM_PRESETS, ...Object.keys(counts).filter((k) => k && k !== TERM_NONE)])];
}

export function termCountsOf(logs: LogEntry[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const l of logs) { const k = (l.term || '').trim() || TERM_NONE; c[k] = (c[k] || 0) + 1; }
  return c;
}

export const matchesTerm = (l: LogEntry, filter: string) =>
  filter === 'all' ? true : filter === TERM_NONE ? !(l.term || '').trim() : (l.term || '').trim() === filter;

/** Human label for a term filter, e.g. for export titles. */
export const termFilterLabel = (filter: string) =>
  filter === 'all' ? '' : filter === TERM_NONE ? 'Not marked' : filter;

// One soft colour per term, same pill look as the category chips.
export function termStyle(term?: string): { pill: string; dot: string } {
  const t = (term || '').toLowerCase();
  if (t.startsWith('first')) return { pill: 'bg-sky-50 text-sky-700', dot: 'bg-sky-500' };
  if (t.startsWith('second')) return { pill: 'bg-violet-50 text-violet-700', dot: 'bg-violet-500' };
  if (t.startsWith('third')) return { pill: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' };
  if (t.startsWith('fourth')) return { pill: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500' };
  return { pill: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' };
}
