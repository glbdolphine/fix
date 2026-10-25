import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { blobPath, blobRoot, hashFile, isSha, listBlobs, removeStaleTmp } from './blobs';

// Shared by the daily background backup (scripts/daily-backup.ts), `npm run backup` and `npm run restore`.
// None of this runs inside the web server process, so a slow check on a big database never freezes the site.
//
// How a backup works now:
//   1. The database (metadata only, a few MB) is copied with VACUUM INTO: one consistent read snapshot that keeps
//      working while people keep editing. The site is NOT put into maintenance mode.
//   2. The attached forms are immutable files named by their hash, so only the ones the destination does not have
//      yet are copied (and each copy is hash-checked). Every backup is therefore "full" for restore purposes but
//      costs only what is new.
//   3. Retention: the newest N daily snapshots plus one per week for W weeks. Forms that no kept snapshot
//      refers to are removed from the destination.

export const SECRET_KEY_NAME = 'pace_it_secret.key';
/** Small files outside the database that are kept beside every backup. (edc-cache.dat is rebuilt from toscrape.xlsx on start.) */
export const EXTRA_FILES = [SECRET_KEY_NAME, 'toscrape.xlsx', 'index.json'];

export interface SnapshotInfo {
  file: string;
  userVersion: number;
  logs: number;
  users: number;
  forms: number;
  /** hashes of every attached form the snapshot refers to */
  refs: string[];
  /** forms stored inside the snapshot itself (a backup made by an older version of the app) */
  legacyInline: number;
}

export type Log = (msg: string) => void;
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** One consistent copy of the live database. Works while the website is running and being edited. */
export function snapshotDb(liveFile: string, destFile: string): void {
  fs.rmSync(destFile, { force: true });
  const d = new DatabaseSync(liveFile);
  try {
    d.exec('PRAGMA busy_timeout = 60000');
    d.exec(`VACUUM INTO ${quote(destFile)}`);
  } finally {
    d.close();
  }
}

function hasColumn(d: DatabaseSync, table: string, col: string): boolean {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

/** Opens a snapshot read-only and checks it. Throws a plain sentence when it is not good. */
export function verifySnapshot(file: string): SnapshotInfo {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const verdict = String((d.prepare('PRAGMA integrity_check').get() as any)?.integrity_check);
    if (verdict !== 'ok') throw new Error(`SQLite integrity check failed: ${verdict}`);
    const n = (sql: string) => Number((d.prepare(sql).get() as any)?.c || 0);
    const userVersion = Number((d.prepare('PRAGMA user_version').get() as any)?.user_version || 0);
    const users = n('SELECT COUNT(*) AS c FROM users');
    if (users < 1) throw new Error('it has no user accounts');
    const logs = n('SELECT COUNT(*) AS c FROM logs');
    let forms = 0;
    let refs: string[] = [];
    let legacyInline = 0;
    if (hasColumn(d, 'attachments', 'sha256')) {
      refs = (d.prepare('SELECT DISTINCT sha256 FROM attachments').all() as { sha256: string }[]).map((r) => r.sha256).filter(isSha);
      forms = n('SELECT COUNT(*) AS c FROM attachments');
    } else if (hasColumn(d, 'attachments', 'data')) {
      forms = n('SELECT COUNT(*) AS c FROM attachments');
      legacyInline = n('SELECT COUNT(*) AS c FROM attachments WHERE length(data) > 0');
      if (legacyInline !== forms) throw new Error(`${forms - legacyInline} attached form(s) are empty inside the snapshot`);
    }
    return { file, userVersion, logs, users, forms, refs, legacyInline };
  } finally {
    d.close();
  }
}

/** The hashes the (live) database refers to. */
export function liveRefs(liveFile: string): Set<string> {
  const d = new DatabaseSync(liveFile, { readOnly: true });
  try {
    d.exec('PRAGMA busy_timeout = 30000');
    if (!hasColumn(d, 'attachments', 'sha256')) return new Set();
    return new Set((d.prepare('SELECT DISTINCT sha256 FROM attachments').all() as { sha256: string }[]).map((r) => r.sha256).filter(isSha));
  } finally {
    d.close();
  }
}

// ---- dates and retention -----------------------------------------------------------------------------------------

/** Reads the date out of pace_it-YYYY-MM-DD.sqlite (daily) or pace_it-YYYYMMDD-HHMMSS.sqlite (drive copies). */
export function parseStamp(name: string): Date | null {
  let m = name.match(/^pace_it-(\d{4})-(\d{2})-(\d{2})\.sqlite$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  m = name.match(/^pace_it-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sqlite$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return null;
}

function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${week}`;
}

/** The snapshots to keep: the newest `daily`, plus the newest one of each of the `weeks` weeks before that. */
export function chooseKeep(names: string[], daily: number, weeks: number): Set<string> {
  const items = names
    .map((n) => ({ n, d: parseStamp(n) }))
    .filter((x): x is { n: string; d: Date } => x.d !== null)
    .sort((a, b) => b.d.getTime() - a.d.getTime() || b.n.localeCompare(a.n));
  const keep = new Set<string>(items.slice(0, daily).map((x) => x.n));
  const seen = new Set<string>(items.slice(0, daily).map((x) => weekKey(x.d)));
  let extra = 0;
  for (const x of items.slice(daily)) {
    if (extra >= weeks) break;
    const wk = weekKey(x.d);
    if (seen.has(wk)) continue;
    seen.add(wk);
    keep.add(x.n);
    extra++;
  }
  return keep;
}

export function snapshotNames(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((f) => parseStamp(f) !== null); } catch { return []; }
}

// ---- disks --------------------------------------------------------------------------------------------------------

export function freeBytes(p: string): number {
  try {
    const s = fs.statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity; // unknown: do not block
  }
}

/** True when both paths are on the same physical volume (so one failing disk would take both). */
export function sameDisk(a: string, b: string): boolean {
  try {
    if (process.platform === 'win32') return path.parse(path.resolve(a)).root.toUpperCase() === path.parse(path.resolve(b)).root.toUpperCase();
    const find = (p: string) => { let x = path.resolve(p); while (!fs.existsSync(x) && path.dirname(x) !== x) x = path.dirname(x); return fs.statSync(x).dev; };
    return find(a) === find(b);
  } catch {
    return false;
  }
}

// ---- the backup itself --------------------------------------------------------------------------------------------

export interface BackupOptions {
  dataDir: string;
  liveFile: string;
  /** folder that receives the snapshot file */
  dbDir: string;
  fileName: string;
  /** when set, attached forms are copied here (a drive mirror). When null the snapshot refers to the live forms. */
  blobsDir: string | null;
  /** when set, the key and the institute list are copied here */
  extrasDir: string | null;
  keepDaily: number;
  keepWeeks: number;
  /** skip the "much smaller than the last backup" safety stop */
  force?: boolean;
  /** how many already-copied forms to re-read and re-hash on this run (slow rot detection) */
  scrub?: number;
  log: Log;
}

export interface BackupResult {
  file: string;
  created: boolean;
  logs: number;
  forms: number;
  blobsCopied: number;
  blobBytes: number;
  missingBlobs: string[];
  pruned: number;
  scrubbed: number;
  warnings: string[];
}

async function copyBlobVerified(src: string, dest: string, sha: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    await fs.promises.copyFile(src, tmp);
    const got = await hashFile(tmp);
    if (got !== sha) throw new Error(`the copy of ${sha.slice(0, 12)}... does not match its hash`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export async function backupSnapshot(o: BackupOptions): Promise<BackupResult> {
  const { dataDir, log } = o;
  const warnings: string[] = [];
  fs.mkdirSync(o.dbDir, { recursive: true });
  const finalFile = path.join(o.dbDir, o.fileName);
  const result: BackupResult = { file: finalFile, created: false, logs: 0, forms: 0, blobsCopied: 0, blobBytes: 0, missingBlobs: [], pruned: 0, scrubbed: 0, warnings };
  if (fs.existsSync(finalFile)) return result; // never replace a finished backup

  // leftovers of an interrupted run
  for (const f of fs.existsSync(o.dbDir) ? fs.readdirSync(o.dbDir) : []) if (/\.tmp(-wal|-shm|-journal)?$/.test(f)) fs.rmSync(path.join(o.dbDir, f), { force: true });

  const tmp = `${finalFile}.tmp`;
  const dbSize = (() => { try { return fs.statSync(o.liveFile).size; } catch { return 0; } })();
  if (freeBytes(o.dbDir) < dbSize * 1.5 + 50 * 1048576) throw new Error(`not enough free space for the database copy in ${o.dbDir}`);

  log('Copying the database (consistent snapshot, the website keeps working) ...');
  snapshotDb(o.liveFile, tmp);
  let info: SnapshotInfo;
  try {
    info = verifySnapshot(tmp);
  } catch (e: any) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`the copy is not good, so it was deleted: ${e?.message || e}`);
  }
  result.logs = info.logs;
  result.forms = info.forms;

  // Forms first, then the snapshot gets its final name: a snapshot that exists is always complete.
  if (o.blobsDir) {
    const liveRoot = blobRoot(dataDir);
    const missing: { sha: string; size: number }[] = [];
    let needBytes = 0;
    for (const sha of info.refs) {
      const dest = blobPath(o.blobsDir, sha);
      if (fs.existsSync(dest)) continue;
      const src = blobPath(liveRoot, sha);
      let size = -1;
      try { size = fs.statSync(src).size; } catch { /* missing in live too */ }
      if (size < 0) { result.missingBlobs.push(sha); continue; }
      missing.push({ sha, size });
      needBytes += size;
    }
    if (freeBytes(o.blobsDir) < needBytes * 1.05 + 50 * 1048576) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`not enough free space for ${missing.length} new attached form(s) (${(needBytes / 1073741824).toFixed(2)} GB needed)`);
    }
    if (missing.length) log(`Copying ${missing.length} new attached form(s) (${(needBytes / 1048576).toFixed(1)} MB) ...`);
    let done = 0;
    for (const m of missing) {
      try {
        await copyBlobVerified(blobPath(liveRoot, m.sha), blobPath(o.blobsDir, m.sha), m.sha);
        result.blobsCopied++;
        result.blobBytes += m.size;
      } catch (e: any) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`could not copy an attached form (${e?.message || e}). The backup was not kept.`);
      }
      if (++done % 200 === 0) log(`  ${done} / ${missing.length} forms copied ...`);
    }
    if (result.missingBlobs.length) warnings.push(`${result.missingBlobs.length} attached form(s) are listed in the database but missing from the live files folder (not caused by the backup)`);

    // slow rot detection: re-read a few older copies and compare with their hash
    const scrub = o.scrub ?? 0;
    if (scrub > 0) {
      const all = [...listBlobs(o.blobsDir)];
      for (let i = 0; i < Math.min(scrub, all.length); i++) {
        const pick = all[Math.floor(Math.random() * all.length)];
        try {
          if ((await hashFile(pick.file)) !== pick.sha) {
            warnings.push(`the backup copy of attached form ${pick.sha.slice(0, 12)}... is damaged; it was removed and will be copied again next time`);
            fs.rmSync(pick.file, { force: true });
          }
          result.scrubbed++;
        } catch { /* unreadable: next time */ }
      }
    }
  }

  fs.renameSync(tmp, finalFile);
  for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(tmp + ext, { force: true });
  result.created = true;

  if (o.extrasDir) {
    try {
      fs.mkdirSync(o.extrasDir, { recursive: true });
      for (const name of EXTRA_FILES) {
        const src = path.join(dataDir, name);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(o.extrasDir, name);
        fs.copyFileSync(src, dest);
        if (name === SECRET_KEY_NAME) { try { fs.chmodSync(dest, 0o600); } catch { /* not supported */ } }
      }
    } catch (e: any) {
      warnings.push(`could not copy the secret key / institute list (${e?.message || e})`);
    }
  }

  // ---- retention ---------------------------------------------------------------------------------------------
  const names = snapshotNames(o.dbDir).filter((n) => n !== o.fileName);
  let shrink = '';
  if (!o.force) {
    const prev = names.map((n) => ({ n, d: parseStamp(n)! })).sort((a, b) => b.d.getTime() - a.d.getTime())[0];
    if (prev) {
      try {
        const before = verifySnapshot(path.join(o.dbDir, prev.n)).logs;
        if (before >= 20 && info.logs < before * 0.5) shrink = `the database now has ${info.logs} connections but the previous backup had ${before}`;
      } catch { /* previous copy unreadable: nothing to compare */ }
    }
  }
  if (shrink) {
    warnings.push(`${shrink}. Older backups were NOT deleted. If this was expected, run again with --force.`);
  } else {
    const keep = chooseKeep([...names, o.fileName], o.keepDaily, o.keepWeeks);
    for (const n of names) {
      if (keep.has(n)) continue;
      try { fs.unlinkSync(path.join(o.dbDir, n)); result.pruned++; } catch { /* in use */ }
    }
    if (o.blobsDir) pruneMirrorBlobs(o.dbDir, o.blobsDir, log, warnings);
  }
  return result;
}

/** Removes mirror forms that no kept snapshot refers to. Does nothing if any kept snapshot cannot be read. */
function pruneMirrorBlobs(dbDir: string, blobsDir: string, log: Log, warnings: string[]): void {
  const wanted = new Set<string>();
  for (const n of snapshotNames(dbDir)) {
    try { for (const r of verifySnapshot(path.join(dbDir, n)).refs) wanted.add(r); }
    catch { warnings.push(`kept snapshot ${n} could not be read, so unused forms were not cleaned from the backup`); return; }
  }
  let removed = 0;
  for (const b of listBlobs(blobsDir)) {
    if (wanted.has(b.sha) || Date.now() - b.mtimeMs < 2 * 86400_000) continue;
    try { fs.unlinkSync(b.file); removed++; } catch { /* ignore */ }
  }
  removeStaleTmp(blobsDir);
  if (removed) log(`Removed ${removed} attached form(s) that no kept backup needs any more.`);
}

// ---- live clean-up and health -----------------------------------------------------------------------------------

/**
 * Deletes attached-form files that the live database and every local snapshot no longer refer to and that are older
 * than `minAgeDays`. A form removed in the app therefore disappears from disk only after the last backup that still
 * contains it has aged out.
 */
export function gcLiveBlobs(dataDir: string, liveFile: string, localSnapshotDir: string, minAgeDays: number, log: Log): number {
  const keep = liveRefs(liveFile);
  // every snapshot in the folder counts, including the safety copies made before a restore or a wipe
  const all = (() => { try { return fs.readdirSync(localSnapshotDir).filter((f) => /\.sqlite$/.test(f)); } catch { return []; } })();
  for (const n of all) {
    try { for (const r of verifySnapshot(path.join(localSnapshotDir, n)).refs) keep.add(r); }
    catch { log(`Skipping the unused-file clean-up: ${n} could not be read.`); return 0; }
  }
  const root = blobRoot(dataDir);
  let removed = 0;
  for (const b of listBlobs(root)) {
    if (keep.has(b.sha) || Date.now() - b.mtimeMs < minAgeDays * 86400_000) continue;
    try { fs.unlinkSync(b.file); removed++; } catch { /* in use */ }
  }
  removeStaleTmp(root);
  return removed;
}

export interface HealthReport {
  ok: boolean;
  quickCheck: string;
  problems: string[];
  notes: string[];
}

/** Checks the live database with its own connection (never inside the web server). Orphan rows are reported, not changed. */
export function healthCheck(dataDir: string, liveFile: string): HealthReport {
  const rep: HealthReport = { ok: true, quickCheck: '', problems: [], notes: [] };
  const d = new DatabaseSync(liveFile, { readOnly: true });
  try {
    d.exec('PRAGMA busy_timeout = 60000');
    rep.quickCheck = String((d.prepare('PRAGMA quick_check').get() as any)?.quick_check);
    if (rep.quickCheck !== 'ok') { rep.ok = false; rep.problems.push(`quick_check: ${rep.quickCheck}`); }
    const n = (sql: string) => Number((d.prepare(sql).get() as any)?.c || 0);
    // Foreign keys are not enforced by the database, so look for broken links here.
    const orphanForms = n('SELECT COUNT(*) AS c FROM attachments WHERE log_id NOT IN (SELECT id FROM logs)');
    if (orphanForms) rep.notes.push(`${orphanForms} attached form(s) belong to a connection that no longer exists`);
    const noForm = n("SELECT COUNT(*) AS c FROM logs WHERE deleted_at IS NULL AND upac_form_name IS NOT NULL AND upac_form_name <> '' AND id NOT IN (SELECT log_id FROM attachments)");
    if (noForm) rep.problems.push(`${noForm} connection(s) list an attached form that has no file`);
    const badForeman = n("SELECT COUNT(*) AS c FROM logs WHERE foreman_id IS NOT NULL AND foreman_id <> '' AND foreman_id NOT IN (SELECT id FROM foremen)");
    if (badForeman) rep.notes.push(`${badForeman} connection(s) point to a foreman that does not exist`);
    const badApproval = n('SELECT COUNT(*) AS c FROM approvals WHERE log_id NOT IN (SELECT id FROM logs)');
    if (badApproval) rep.notes.push(`${badApproval} approval(s) point to a connection that does not exist`);
    const badTeam = n('SELECT COUNT(*) AS c FROM team_members WHERE foreman_id NOT IN (SELECT id FROM foremen)');
    if (badTeam) rep.notes.push(`${badTeam} team member(s) point to a foreman that does not exist`);
    if (rep.problems.length) rep.ok = false;

    // stored forms that are missing on disk
    if (hasColumn(d, 'attachments', 'sha256')) {
      const root = blobRoot(dataDir);
      let missing = 0;
      for (const r of d.prepare('SELECT sha256 FROM attachments').all() as { sha256: string }[]) {
        if (!fs.existsSync(blobPath(root, r.sha256))) missing++;
      }
      if (missing) { rep.ok = false; rep.problems.push(`${missing} attached form file(s) are missing from the files folder`); }
    }
  } finally {
    d.close();
  }
  return rep;
}
