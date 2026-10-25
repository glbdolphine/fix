import { upazilaKey } from '../src/utils/upazilas';
import { normalizeTarget, sameTarget, type TargetInstitute } from '../src/utils/targetNorm';

export type { TargetInstitute };

const MAX_ROWS = 50000;

// The list is stored in the database (targets table). The database registers itself here when it starts,
// so this file needs no database import of its own.
interface TargetStore { load(): unknown[]; save(list: TargetInstitute[]): void; version(): number }
let store: TargetStore | null = null;
export function registerTargetStore(s: TargetStore) { store = s; }

export function loadTargets(): TargetInstitute[] {
  try {
    if (!store) return [];
    const out: TargetInstitute[] = [];
    for (const o of store.load()) {
      const t = o && typeof o === 'object' ? normalizeTarget(o as Record<string, unknown>) : null;
      if (t) out.push(t);
    }
    return out;
  } catch (err: any) {
    console.error('[Pace IT] Could not read the targets list:', err?.message || err);
    return [];
  }
}

function saveTargets(list: TargetInstitute[]) {
  if (!store) throw new Error('The database is not ready.');
  store.save(list); // one transaction: never leaves a half-written list behind
}

// EDC number -> the upazila the workbook says the institute is in (cached until the targets list changes).
let upaCache: { version: number; map: Map<string, string> } | null = null;
export function targetUpazilaMap(): Map<string, string> {
  const version = store ? store.version() : -1;
  if (upaCache && upaCache.version === version) return upaCache.map;
  const map = new Map<string, string>();
  for (const t of loadTargets()) {
    const k = upazilaKey(t.upazila);
    if (k) map.set(edcNorm(t.edc), k);
  }
  upaCache = { version, map };
  return map;
}
export const edcNorm = (v: unknown) => String(v ?? '').trim().replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/^0+(?=\d)/, '').toLowerCase();

export interface ImportResult { added: number; updated: number; unchanged: number; skipped: number; removed: number; total: number }

export function importTargets(rows: unknown[], opts: { replace?: boolean } = {}): ImportResult {
  if (rows.length > MAX_ROWS) throw new Error(`Too many rows (max ${MAX_ROWS}).`);
  const list = loadTargets();
  const byEdc = new Map(list.map((t) => [t.edc, t] as const));
  let added = 0, updated = 0, unchanged = 0, skipped = 0, removed = 0;
  const incoming = new Set<string>();

  for (const r of rows) {
    const next = r && typeof r === 'object' ? normalizeTarget(r as Record<string, unknown>) : null;
    if (!next) { skipped++; continue; }
    incoming.add(next.edc);
    const old = byEdc.get(next.edc);
    if (!old) { list.push(next); byEdc.set(next.edc, next); added++; continue; }
    if (sameTarget(old, next)) { unchanged++; continue; }
    // Overwrite every field, so optional details that disappeared from the file disappear here too.
    for (const k of Object.keys(old)) delete (old as any)[k];
    Object.assign(old, next);
    updated++;
  }

  let result = list;
  if (opts.replace && incoming.size > 0) {
    result = list.filter((t) => incoming.has(t.edc));
    removed = list.length - result.length;
  }
  if (added || updated || removed) saveTargets(result);
  return { added, updated, unchanged, skipped, removed, total: result.length };
}

export function clearTargets(): number {
  const n = loadTargets().length;
  saveTargets([]);
  return n;
}
