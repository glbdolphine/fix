import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { targetUpazilaMap, edcNorm, registerTargetStore } from './targets';
import { upazilaKey, foremanLogName, foremanServes } from '../src/utils/upazilas';
import { resolveCategory, displayCategory, stripCategoryNumber } from '../src/utils/category';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readMaintenance, MaintenanceInfo } from './maintenance';
import { writeBlob, readBlob, blobPath, blobRoot, sha256Of, isSha } from './blobs';
import { runMigrations } from './migrations';
import { snapshotDb, verifySnapshot, SECRET_KEY_NAME } from './backupCore';
import { validateFullBackupShape } from './validation';

type SqlValue = string | number | null | Uint8Array;

class NativeDb {
  constructor(public readonly raw: DatabaseSync) {}

  private bind(params?: unknown[]): SqlValue[] {
    return (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlValue)));
  }

  run(sql: string, params?: unknown[]): void {
    if (!params || params.length === 0) {
      this.raw.exec(sql); // also handles several statements in one string
      return;
    }
    this.raw.prepare(sql).run(...this.bind(params));
  }

  /** Rows as objects: `db.all('SELECT id, name FROM x WHERE a = ?', [1])[0].name`. Prefer this (and get / scalar) in new code. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    return this.raw.prepare(sql).all(...this.bind(params)) as unknown as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...this.bind(params)) as unknown as T | undefined;
  }

  /** The first column of the first row (a COUNT, a single value), or undefined. */
  scalar(sql: string, params?: unknown[]): SqlValue | undefined {
    const row = this.raw.prepare(sql).get(...this.bind(params)) as Record<string, SqlValue> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  /** Old sql.js-shaped result (columns + arrays of values). Kept only for the queries that have not been converted to all/get/scalar yet. */
  exec(sql: string, params?: unknown[]): { columns: string[]; values: SqlValue[][] }[] {
    const stmt = this.raw.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    if (!columns.length) {
      stmt.run(...this.bind(params)); // INSERT / UPDATE / DDL: nothing to read back
      return [];
    }
    stmt.setReturnArrays(true);
    const values = stmt.all(...this.bind(params)) as unknown as SqlValue[][];
    if (!values.length) return [];
    return [{ columns, values }];
  }

  pragma(name: string): unknown {
    const row = this.raw.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  }
}

function parseRoamAreas(v: unknown): string[] {
  return String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
}

export * from './dbTypes';
export * from './passwords';
export { ATTACH_MAX_BYTES, SAFE_ATTACHMENT_TYPES } from './blobs';
import type { AppUser, StoredUser, LogChange, LogEntry, MarkKind, MarkAction, ImportRequest, ApprovalRequest, Foreman, TeamMember, ActivityEvent, LogFieldKey, FieldSuggestionsMap } from './dbTypes';
import { INITIAL_SUGGESTIONS } from './dbTypes';
import { SESSION_TTL_MS, SESSION_IDLE_MS, hashPassword, isPasswordHash, verifyPassword, randomPassword, cleanPhotoUrl, passwordProblem } from './passwords';
import { ATTACH_MAX_BYTES, SAFE_ATTACHMENT_TYPES, sniffAttachment, decodeAttachment } from './blobs';

// Where all data lives. Keep it OUTSIDE the project folder (set PACE_DATA_DIR) so code zips/copies never carry it.
const DB_DIR = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const SQLITE_FILE = path.join(DB_DIR, 'pace_it.sqlite');
const BACKUP_DIR = path.join(DB_DIR, 'backups');
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECRET_FILE = path.join(DB_DIR, SECRET_KEY_NAME);

function getOrGenerateSecret(): string {
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s) return s;
    } catch {
      /* fallback */
    }
  }
  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, newSecret, 'utf-8');
  } catch {
    /* non-fatal */
  }
  return newSecret;
}

const LEGACY_KEY_MAP: Record<string, string> = {
  resellerName: 'foremanName', reseller_name: 'foremanName',
  resellerPhone: 'foremanPhone', reseller_phone: 'foremanPhone',
  resellerInformed: 'foremanInformed', reseller_informed: 'foremanInformed',
  resellerId: 'foremanId', reseller_id: 'foremanId',
};
export function upgradeLegacyLog<T = any>(o: T): T {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const src: any = o;
  const out: any = { ...src };
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
    if (oldKey in out) {
      if (out[newKey] === undefined || out[newKey] === null || out[newKey] === '') out[newKey] = out[oldKey];
      delete out[oldKey];
    }
  }
  if (Array.isArray(out.history)) {
    out.history = out.history.map((h: any) => (h && Array.isArray(h.changes)
      ? { ...h, changes: h.changes.map((c: any) => (c && LEGACY_KEY_MAP[c.field] ? { ...c, field: LEGACY_KEY_MAP[c.field] } : c)) }
      : h));
  }
  if (src.data && typeof src.data === 'object') out.data = upgradeLegacyLog(src.data);
  return out as T;
}

export const FULL_BACKUP_FORMAT = 'pace-it-full-backup';
export interface FullBackup {
  format: typeof FULL_BACKUP_FORMAT;
  version: number;
  appName: string;
  exportedAt: string;
  counts: Record<string, number>;
  tables: Record<string, { columns: string[]; rows: unknown[][] }>;
}

class SQLiteDatabase extends EventEmitter {
  private sqlite!: NativeDb;
  private secret: string = getOrGenerateSecret();
  private initialized = false;
  private initPromise: Promise<void>;

  constructor() {
    super();
    this.setMaxListeners(0); // one listener per open live-update stream (4-10 people x several tabs)
    this.initPromise = this.init();
    // Without this a failed start is an "unhandled rejection" with a confusing stack trace. Say it plainly and stop.
    this.initPromise.catch((err) => {
      console.error('\n[Pace IT] THE DATABASE COULD NOT BE STARTED. Nothing was changed.\n', err);
      process.exit(1);
    });
  }

  public async ready(): Promise<void> {
    return this.initPromise;
  }

  private async init() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.sqlite = new NativeDb(this.openNative());

    // Numbered migrations (server/migrations.ts) bring a new or old database to the current shape, once each.
    runMigrations(this.sqlite.raw, SQLITE_FILE, DB_DIR);
    this.ensureDefaults();
    this.registerTargets();
    this.seedAllForemen();
    this.repairDuplicateLogNumbers();
    this.initialized = true;
    this.startBackgroundJobs();
  }

  private openNative(): DatabaseSync {
    // quick_check reads the whole file and node:sqlite is synchronous, so on a very large database it would keep the
    // site unreachable for a long time at every start. Past this size the check is left to the nightly job
    // (which runs in its own process and writes data/backups/!DATABASE-PROBLEM.txt on failure).
    const maxMb = Number(process.env.PACE_STARTUP_CHECK_MAX_MB || 512);
    const open = (file: string) => {
      const d = new DatabaseSync(file);
      d.exec('PRAGMA busy_timeout = 5000');
      d.exec('PRAGMA synchronous = FULL');
      d.exec('PRAGMA foreign_keys = OFF'); // the schema declares no foreign keys; the nightly health check reports broken links
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new file */ }
      if (size <= maxMb * 1048576) {
        const chk = (d.prepare('PRAGMA quick_check').get() as Record<string, unknown>)?.quick_check;
        if (chk !== 'ok') {
          d.close();
          throw new Error(`SQLite quick_check failed: ${chk}`);
        }
      } else {
        console.log(`[Pace IT] The database is ${(size / 1073741824).toFixed(1)} GB: the start-up check is skipped (the nightly job checks it).`);
      }
      d.exec('PRAGMA journal_mode = WAL');
      return d;
    };
    try {
      return open(SQLITE_FILE);
    } catch (err) {
      console.error('[Pace IT] Failed to open the database:', err);
      // Never silently start with an empty database over real data: stop and let the owner decide.
      if (fs.existsSync(SQLITE_FILE) && fs.statSync(SQLITE_FILE).size > 0) {
        throw new Error('The database file exists but could not be opened. It has NOT been modified. Run "npm run restore" to restore from data/backups.');
      }
      return open(SQLITE_FILE);
    }
  }

  /** Things every start makes sure of (the schema itself is handled by the numbered migrations). */
  private ensureDefaults() {
    // Older databases kept passwords as plain text: hash every one of them, once.
    try {
      const rows = this.sqlite.exec('SELECT id, password FROM users');
      let migrated = 0;
      for (const [id, pw] of rows[0]?.values ?? []) {
        if (!isPasswordHash(String(pw))) {
          this.sqlite.run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(String(pw)), String(id)]);
          migrated++;
        }
      }
      if (migrated) console.log(`[Pace IT] Secured ${migrated} account password${migrated === 1 ? '' : 's'} (plain text -> scrypt hash).`);
    } catch (pwErr) {
      console.warn('[Pace IT] Password migration notice:', pwErr);
    }

    // Ensure an admin exists. A brand-new install gets a random password, printed once here.
    const adminCheck = this.sqlite.exec("SELECT id FROM users WHERE username = 'admin'");
    if (adminCheck.length === 0 || adminCheck[0].values.length === 0) {
      const first = randomPassword();
      this.sqlite.run(
        'INSERT INTO users (id, username, display_name, password, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), 'admin', 'Administrator', hashPassword(first), 'admin', 0, new Date().toISOString()]
      );
      console.log('\n[Pace IT] ================================================================');
      console.log('[Pace IT]  First run: administrator account created.');
      console.log(`[Pace IT]  Username: admin    Password: ${first}`);
      console.log('[Pace IT]  Write it down and change it after signing in. It is not shown again.');
      console.log('[Pace IT] ================================================================\n');
    } else {
      const a = this.sqlite.exec("SELECT password FROM users WHERE username = 'admin'");
      const stored = String(a[0]?.values[0]?.[0] ?? '');
      if (['admin', 'admin1234', 'password', '12345678'].some((d) => verifyPassword(d, stored))) {
        console.warn('\n[Pace IT] WARNING: the "admin" account still uses a default password. Change it now (Admin panel > Security).\n');
      }
    }

    // Ensure initial suggestions exist
    const suggCheck = this.sqlite.exec('SELECT field FROM suggestions LIMIT 1');
    if (suggCheck.length === 0 || suggCheck[0].values.length === 0) {
      for (const [field, values] of Object.entries(INITIAL_SUGGESTIONS)) {
        this.sqlite.run('INSERT OR REPLACE INTO suggestions (field, values_json) VALUES (?, ?)', [
          field,
          JSON.stringify(values),
        ]);
      }
    }
  }

  /** Two connections with the same number confuse everyone. The older one keeps its number, the others get the next free ones. */
  private repairDuplicateLogNumbers() {
    try {
      const dups = this.sqlite.exec('SELECT log_no FROM logs GROUP BY log_no HAVING COUNT(*) > 1');
      if (!dups.length) return;
      this.transaction(() => {
        let next = this.getNextLogNo();
        for (const [no] of dups[0].values) {
          const rows = this.sqlite.exec('SELECT id FROM logs WHERE log_no = ? ORDER BY created_at ASC, id ASC', [no])[0]?.values || [];
          for (const [id] of rows.slice(1)) {
            this.sqlite.run('UPDATE logs SET log_no = ? WHERE id = ?', [next, String(id)]);
            console.log(`[Pace IT] Duplicate connection number ${no}: a record was renumbered to ${next}.`);
            this.logSecurity('renumbered', { detail: `duplicate connection no. ${no} -> ${next} (id ${String(id).slice(0, 8)})` });
            next++;
          }
        }
      });
    } catch (err) {
      console.warn('[Pace IT] Duplicate-number check notice:', err);
    }
  }

  // Durability
  //
  // The native engine writes every change straight into data/pace_it.sqlite (WAL journal, synchronous = FULL), so
  // nothing is lost if the process is killed. On top of that:
  //
  //  * ONE automatic backup per calendar day (server clock). It is made by a SEPARATE process (scripts/daily-backup.ts)
  //    so copying, checking and cleaning up never block the website, however big the data gets. "Already done today"
  //    is decided from files on disk, so restarts never produce a second one.
  //  * The attached forms are files named by their hash; a backup only copies the ones its destination lacks.
  //  * If PACE_BACKUP_DIR points to a second drive, the same job mirrors the database, the forms and the secret key there.
  //  * The live database gets a health check once a day in that process. If it fails, old backups are NOT pruned and
  //    data/backups/!DATABASE-PROBLEM.txt is written.
  //  * `npm run backup` (another process) makes the same kind of copy on a drive you choose. Neither closes the website.
  public revision = 0;
  private backupChild: ReturnType<typeof spawn> | null = null;
  private jobTimers: NodeJS.Timeout[] = [];
  private maintenance: MaintenanceInfo | null = null;
  private maintenanceCheckedAt = 0;

  /** Kept so existing call sites compile. Backups are time-based now, not triggered by edits. */
  private scheduleSave() { /* no-op */ }

  flush() {
    /* no-op: native SQLite commits each statement to disk immediately */
  }

  close() {
    for (const t of this.jobTimers) clearInterval(t);
    this.jobTimers = [];
    try {
      this.sqlite.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.sqlite.raw.close();
    } catch {
      /* already closed */
    }
  }

  // Maintenance mode -------------------------------------------------------------------------------------------
  /** The active maintenance lock (made by `npm run restore`), or null. Cheap: re-read at most every 300 ms. */
  getMaintenance(): MaintenanceInfo | null {
    if (Date.now() - this.maintenanceCheckedAt > 300) this.pollMaintenance();
    return this.maintenance;
  }

  private pollMaintenance() {
    const now = readMaintenance(DB_DIR);
    const was = this.maintenance;
    this.maintenance = now;
    this.maintenanceCheckedAt = Date.now();
    if (Boolean(now) !== Boolean(was)) {
      this.emit('change', { type: 'maintenance', payload: { on: Boolean(now), reason: now?.reason, since: now?.since }, timestamp: new Date().toISOString() });
    }
  }

  private startBackgroundJobs() {
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(() => { try { fn(); } catch (e) { console.error('[Pace IT] Background job failed:', e); } }, ms);
      t.unref();
      this.jobTimers.push(t);
    };
    every(1000, () => this.pollMaintenance());
    every(5 * 60 * 1000, () => this.dailyBackup());
    every(60 * 60 * 1000, () => { try { this.sqlite.raw.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* busy: next time */ } });
    every(60 * 60 * 1000, () => {
      if (this.getMaintenance()) return;
      // housekeeping: expired logins, and an activity feed that would otherwise grow forever
      try { this.sqlite.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]); } catch { /* next hour */ }
      try { this.sqlite.run('DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY at DESC LIMIT -1 OFFSET 50000)'); } catch { /* next hour */ }
    });
    const first = setTimeout(() => this.dailyBackup(), 20_000); // shortly after every start
    first.unref();
  }

  private localDay(d = new Date()): string {
    const two = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }

  /** Starts the backup helper process when today's backup is not done yet (or the second-drive copy still has to be retried). */
  private dailyBackup() {
    if (this.backupChild || !this.initialized) return;
    const day = this.localDay();
    const stateFile = path.join(BACKUP_DIR, 'daily-state.json');
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      let st: any = null;
      try { st = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* no state yet */ }
      const doneToday = fs.existsSync(path.join(BACKUP_DIR, `pace_it-${day}.sqlite`)) || (st && st.day === day && st.ok === true);
      const mirrorPending = Boolean(process.env.PACE_BACKUP_DIR) && st && st.day === day && st.mirrorOk === false;
      const sinceAttempt = st?.attemptedAt ? Date.now() - Date.parse(st.attemptedAt) : Infinity;
      if (doneToday && !mirrorPending) return;
      if (sinceAttempt < (mirrorPending ? 30 : 5) * 60 * 1000) return;

      const script = path.join(PROJECT_ROOT, 'scripts', 'daily-backup.ts');
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, PACE_DATA_DIR: DB_DIR },
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      });
      this.backupChild = child;
      child.on('error', (e) => { console.error('[Pace IT] Could not start the backup helper:', e); this.backupChild = null; });
      child.on('exit', (code) => {
        this.backupChild = null;
        if (code !== 0) console.error(`[Pace IT] The backup helper ended with code ${code} (it will be tried again).`);
      });
    } catch (err) {
      console.error('[Pace IT] Could not start the daily backup:', err);
    }
  }

  private notify(type: string, payload?: any) {
    if (type !== 'activity' && type !== 'suggestions' && type !== 'approvals' && type !== 'imports') this.revision++;
    this.scheduleSave();
    this.emit('change', { type, payload, timestamp: new Date().toISOString() });
  }

  // Auth & Sessions
  // A session is a random 256-bit value in the cookie. The database keeps only a keyed hash of it, so a session can
  // really be ended: logout, a password change, a password reset and disabling an account all remove it immediately.
  private tokenHash(token: string): string {
    return crypto.createHmac('sha256', this.secret).update(token).digest('hex');
  }

  createSession(userId: string): string {
    const now = Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    this.sqlite.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
    this.sqlite.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)',
      [this.tokenHash(token), userId, new Date(now).toISOString(), now + SESSION_TTL_MS, now]
    );
    return token;
  }

  getUserByToken(token: string): AppUser | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = this.tokenHash(token);
    const res = this.sqlite.exec('SELECT user_id, expires_at, last_seen FROM sessions WHERE token_hash = ?', [hash]);
    if (!res.length || !res[0].values.length) return null;
    const [userId, expiresAt, lastSeen] = res[0].values[0];
    const now = Date.now();
    // Ends when the absolute lifetime is over, or when it has not been used for SESSION_IDLE_MS.
    // (Sessions made before this column existed have no last_seen and are treated as just used.)
    if (Number(expiresAt) < now || (lastSeen !== null && lastSeen !== undefined && now - Number(lastSeen) > SESSION_IDLE_MS)) {
      this.sqlite.run('DELETE FROM sessions WHERE token_hash = ?', [hash]);
      return null;
    }
    if (!this.getMaintenance() && (lastSeen === null || lastSeen === undefined || now - Number(lastSeen) > 5 * 60 * 1000)) {
      this.sqlite.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', [now, hash]);
    }
    const full = this.getUserById(String(userId)); // null for a disabled or deleted account
    if (!full) return null;
    const { password: _hidden, ...safe } = full; // the password hash must never leave the server
    return safe;
  }

  /** True while this cookie value still belongs to a live session of an enabled account. Does not count as "use". */
  isSessionActive(token: string): boolean {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const res = this.sqlite.exec('SELECT user_id, expires_at, last_seen FROM sessions WHERE token_hash = ?', [this.tokenHash(token)]);
    if (!res.length || !res[0].values.length) return false;
    const [userId, expiresAt, lastSeen] = res[0].values[0];
    const now = Date.now();
    if (Number(expiresAt) < now) return false;
    if (lastSeen !== null && lastSeen !== undefined && now - Number(lastSeen) > SESSION_IDLE_MS) return false;
    return this.getUserById(String(userId)) !== null;
  }

  destroySession(token: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    this.sqlite.run('DELETE FROM sessions WHERE token_hash = ?', [this.tokenHash(token)]);
  }

  /** End every session of a user, optionally keeping the one that is making the request. */
  destroyUserSessions(userId: string, keepToken?: string) {
    if (keepToken && /^[a-f0-9]{64}$/.test(keepToken)) {
      this.sqlite.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, this.tokenHash(keepToken)]);
    } else {
      this.sqlite.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
  }

  // Security log (administrator only). Logging must never break the request that triggered it.
  logSecurity(type: string, info: { username?: string; ip?: string; detail?: string } = {}) {
    try {
      this.sqlite.run(
        'INSERT INTO security_events (id, at, type, username, ip, detail) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), new Date().toISOString(), type, info.username || null, info.ip || null, info.detail ? String(info.detail).slice(0, 300) : null]
      );
      if (Math.random() < 0.02) {
        const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
        this.sqlite.run('DELETE FROM security_events WHERE at < ?', [cutoff]);
      }
    } catch (err) {
      console.error('[Pace IT] Could not write the security log:', err);
    }
  }

  listSecurityEvents(limit = 300): { id: string; at: string; type: string; username: string; ip: string; detail: string }[] {
    const res = this.sqlite.exec('SELECT id, at, type, username, ip, detail FROM security_events ORDER BY at DESC LIMIT ?', [Math.max(1, Math.min(1000, limit))]);
    if (!res.length) return [];
    return res[0].values.map(([id, at, type, username, ip, detail]) => ({
      id: String(id), at: String(at), type: String(type), username: String(username ?? ''), ip: String(ip ?? ''), detail: String(detail ?? ''),
    }));
  }

  // Users
  getUserById(id: string, includeDisabled = false): StoredUser | null {
    const res = this.sqlite.exec('SELECT id, username, display_name, password, role, disabled, created_at, phone_number, email, photo_url FROM users WHERE id = ?', [id]);
    if (!res.length || !res[0].values.length) return null;
    const [uId, username, displayName, password, role, disabled, createdAt, phoneNumber, email, photoUrl] = res[0].values[0];
    if (Number(disabled) === 1 && !includeDisabled) return null;
    return {
      id: String(uId),
      username: String(username),
      displayName: String(displayName),
      password: String(password),
      role: (role as 'admin' | 'user') || 'user',
      phoneNumber: phoneNumber ? String(phoneNumber) : undefined,
      email: email ? String(email) : undefined,
      photoUrl: photoUrl ? String(photoUrl) : undefined,
      disabled: Boolean(disabled),
      createdAt: String(createdAt),
    };
  }

  getUserByUsername(username: string): StoredUser | null {
    const norm = username.trim().toLowerCase().replace(/\s+/g, '_');
    const res = this.sqlite.exec('SELECT id, username, display_name, password, role, disabled, created_at, phone_number, email, photo_url FROM users WHERE lower(username) = ?', [norm]);
    if (!res.length || !res[0].values.length) return null;
    const [id, uName, displayName, password, role, disabled, createdAt, phoneNumber, email, photoUrl] = res[0].values[0];
    return {
      id: String(id),
      username: String(uName),
      displayName: String(displayName),
      password: String(password),
      role: (role as 'admin' | 'user') || 'user',
      phoneNumber: phoneNumber ? String(phoneNumber) : undefined,
      email: email ? String(email) : undefined,
      photoUrl: photoUrl ? String(photoUrl) : undefined,
      disabled: Boolean(disabled),
      createdAt: String(createdAt),
    };
  }

  listUserAvatars(): { displayName: string; photoUrl: string }[] {
    const res = this.sqlite.exec("SELECT display_name, photo_url FROM users WHERE photo_url IS NOT NULL AND photo_url <> ''");
    if (!res.length) return [];
    return res[0].values.map(([n, p]) => ({ displayName: String(n), photoUrl: String(p) }));
  }

  listUsers(): (AppUser & { createdAt?: string; disabled?: boolean })[] {
    const res = this.sqlite.exec('SELECT id, username, display_name, role, disabled, created_at, phone_number, email, photo_url FROM users ORDER BY created_at ASC');
    if (!res.length) return [];
    return res[0].values.map(([id, username, displayName, role, disabled, createdAt, phoneNumber, email, photoUrl]) => ({
      id: String(id),
      username: String(username),
      displayName: String(displayName),
      role: (role as 'admin' | 'user') || 'user',
      phoneNumber: phoneNumber ? String(phoneNumber) : undefined,
      email: email ? String(email) : undefined,
      photoUrl: photoUrl ? String(photoUrl) : undefined,
      disabled: Boolean(disabled),
      createdAt: String(createdAt),
    }));
  }

  private displayNameTaken(name: string, exceptId?: string): boolean {
    const res = this.sqlite.exec('SELECT id FROM users WHERE lower(trim(display_name)) = ? AND (? IS NULL OR id <> ?)', [name.trim().toLowerCase(), exceptId ?? null, exceptId ?? null]);
    return res.length > 0 && res[0].values.length > 0;
  }

  updateUserProfile(userId: string, input: { displayName?: string; phoneNumber?: string; email?: string; photoUrl?: string }): AppUser {
    const user = this.getUserById(userId);
    if (!user) throw new Error('User not found.');

    const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const newDisplayName = input.displayName !== undefined ? (str(input.displayName, 80) || user.displayName) : user.displayName;
    // Names are what the history and activity feed show, so two accounts must never share one (no pretending to be someone else).
    if (newDisplayName.toLowerCase() !== user.displayName.toLowerCase() && this.displayNameTaken(newDisplayName, userId)) {
      throw new Error('That display name is already used by another account. Please choose a different one.');
    }
    const newPhone = input.phoneNumber !== undefined ? str(input.phoneNumber, 40) : (user.phoneNumber || '');
    const newEmail = input.email !== undefined ? str(input.email, 120) : (user.email || '');
    const newPhotoUrl = input.photoUrl !== undefined ? cleanPhotoUrl(input.photoUrl) : (user.photoUrl || '');

    this.sqlite.run(
      'UPDATE users SET display_name = ?, phone_number = ?, email = ?, photo_url = ? WHERE id = ?',
      [newDisplayName, newPhone || null, newEmail || null, newPhotoUrl || null, userId]
    );

    this.notify('users');
    this.flush();

    return {
      id: user.id,
      username: user.username,
      displayName: newDisplayName,
      role: user.role,
      phoneNumber: newPhone || undefined,
      email: newEmail || undefined,
      photoUrl: newPhotoUrl || undefined,
      disabled: user.disabled,
      createdAt: user.createdAt,
    };
  }

  createUser(username: string, password: string, displayName: string): AppUser {
    if (typeof username !== 'string' || typeof password !== 'string') throw new Error('Username and password are required.');
    displayName = typeof displayName === 'string' ? displayName : '';
    const norm = username.trim().toLowerCase().replace(/\s+/g, '_');
    if (!norm) throw new Error('Username is required.');
    if (norm.length > 40) throw new Error('Username is too long (40 characters at most).');
    const weak = passwordProblem(password, norm);
    if (weak) throw new Error(weak);
    if (this.getUserByUsername(norm)) throw new Error('That username already exists.');

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const cleanDisplay = displayName.trim() || norm;
    if (this.displayNameTaken(cleanDisplay)) throw new Error('That display name is already used by another account.');

    this.sqlite.run(
      'INSERT INTO users (id, username, display_name, password, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, norm, cleanDisplay, hashPassword(password), 'user', 0, createdAt]
    );

    this.notify('users');
    return { id, username: norm, displayName: cleanDisplay, role: 'user', disabled: false, createdAt };
  }

  setUserDisabled(userId: string, disabled: boolean): boolean {
    const user = this.getUserById(userId, true); // must also find disabled users, otherwise they can never be re-enabled
    if (!user) throw new Error('User not found.');
    if (user.role === 'admin' && disabled) throw new Error('Cannot disable the administrator account.');

    this.sqlite.run('UPDATE users SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, userId]);
    if (disabled) this.destroyUserSessions(userId);
    this.notify('users');
    return true;
  }

  /** Stores a stronger hash of the SAME password (no sign-outs). Used at sign-in when an old hash is found. */
  replacePasswordHash(userId: string, hash: string) {
    this.sqlite.run('UPDATE users SET password = ? WHERE id = ?', [hash, userId]);
  }

  /** Sets a new password and signs the account out everywhere (except `keepToken`, the session that made the change). */
  setUserPassword(userId: string, newPassword: string, keepToken?: string): boolean {
    const weak = passwordProblem(newPassword, this.getUserById(userId, true)?.username);
    if (weak) throw new Error(weak);
    if (!this.getUserById(userId, true)) throw new Error('User not found.');
    this.sqlite.run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(newPassword), userId]);
    this.destroyUserSessions(userId, keepToken);
    this.notify('users');
    return true;
  }

  countLiveLogs(): number {
    const res = this.sqlite.exec('SELECT COUNT(*) FROM logs WHERE deleted_at IS NULL');
    return Number(res[0]?.values[0]?.[0] || 0);
  }

  // Logs
  private rowToLog(row: SqlValue[], colNames?: string[]): LogEntry {
    let r: Record<string, any> = {};
    if (colNames && colNames.length) {
      for (let i = 0; i < colNames.length; i++) {
        r[colNames[i]] = row[i];
      }
    } else {
      const [
        id, logNo, date, foremanName, callerPhone, requestType, customerName,
        nmsId, issueFound, missingWrongDetails, actionTaken, reasonForAction,
        foremanInformed, followUpNeeded, status, supervisorInformed, remarks, mac,
        edcNo, routerSerial, formReceivedAt, foremanId, followUpDate,
        deletedAt, deletedBy, createdAt, updatedAt, createdBy, updatedBy, history,
        foremanPhone, headTeacherName, headTeacherPhone, lat, long, unionName, upazila, fiberLength, category
      ] = row;
      r = {
        id, log_no: logNo, date, foreman_name: foremanName, caller_phone: callerPhone,
        request_type: requestType, customer_name: customerName, nms_id: nmsId,
        issue_found: issueFound, missing_wrong_details: missingWrongDetails,
        action_taken: actionTaken, reason_for_action: reasonForAction,
        foreman_informed: foremanInformed, follow_up_needed: followUpNeeded,
        status, supervisor_informed: supervisorInformed, remarks, mac,
        edc_no: edcNo, router_serial: routerSerial, form_received_at: formReceivedAt,
        foreman_id: foremanId, follow_up_date: followUpDate, deleted_at: deletedAt,
        deleted_by: deletedBy, created_at: createdAt, updated_at: updatedAt,
        created_by: createdBy, updated_by: updatedBy, history,
        foreman_phone: foremanPhone, head_teacher_name: headTeacherName,
        head_teacher_phone: headTeacherPhone, lat, long, union_name: unionName,
        upazila, fiber_length: fiberLength, category
      };
    }

    let parsedHistory: LogChange[] = [];
    try {
      if (r.history) parsedHistory = JSON.parse(String(r.history));
    } catch {
      /* ignore */
    }

    return {
      id: String(r.id || ''),
      logNo: Number(r.log_no ?? 1),
      date: String(r.date || ''),
      foremanName: String(r.foreman_name || ''),
      requestType: String(r.request_type || ''),
      customerName: String(r.customer_name || ''),
      nmsId: String(r.nms_id || ''),
      issueFound: String(r.issue_found || ''),
      missingWrongDetails: String(r.missing_wrong_details || ''),
      actionTaken: String(r.action_taken || ''),
      reasonForAction: String(r.reason_for_action || ''),
      foremanInformed: String(r.foreman_informed || ''),
      followUpNeeded: String(r.follow_up_needed || ''),
      status: String(r.status || ''),
      supervisorInformed: String(r.supervisor_informed || ''),
      remarks: String(r.remarks || ''),
      mac: String(r.mac || ''),
      edcNo: r.edc_no ? String(r.edc_no) : undefined,
      emisEiinDghs: r.emis_eiin_dghs ? String(r.emis_eiin_dghs) : undefined,
      routerSerial: r.router_serial ? String(r.router_serial) : undefined,
      formReceivedAt: r.form_received_at ? String(r.form_received_at) : undefined,
      foremanId: r.foreman_id ? String(r.foreman_id) : undefined,
      followUpDate: r.follow_up_date ? String(r.follow_up_date) : undefined,
      foremanPhone: (r.foreman_phone || r.caller_phone) ? String(r.foreman_phone || r.caller_phone) : undefined,
      headTeacherName: r.head_teacher_name ? String(r.head_teacher_name) : undefined,
      headTeacherPhone: r.head_teacher_phone ? String(r.head_teacher_phone) : undefined,
      lat: r.lat ? String(r.lat) : undefined,
      long: r.long ? String(r.long) : undefined,
      unionName: r.union_name ? String(r.union_name) : undefined,
      upazila: r.upazila ? String(r.upazila) : undefined,
      fiberLength: r.fiber_length ? String(r.fiber_length) : undefined,
      category: displayCategory({
        nameBn: r.name_bn ? String(r.name_bn) : undefined,
        nameEn: r.name_en ? String(r.name_en) : undefined,
        customerName: String(r.customer_name || ''),
        category: r.category ? String(r.category) : undefined,
      }) || undefined,
      nameBn: r.name_bn ? String(r.name_bn) : undefined,
      nameEn: r.name_en ? String(r.name_en) : undefined,
      billReceivedAt: r.bill_received_at ? String(r.bill_received_at) : undefined,
      billMonths: (() => {
        try {
          const a = r.bill_months ? JSON.parse(String(r.bill_months)) : [];
          return Array.isArray(a) ? a.map(String).sort() : [];
        } catch { return []; }
      })(),
      term: r.term ? String(r.term) : undefined,
      upacFormName: r.upac_form_name ? String(r.upac_form_name) : undefined,
      upacFormType: r.upac_form_type ? String(r.upac_form_type) : undefined,
      upacFormSize: r.upac_form_size !== undefined && r.upac_form_size !== null ? Number(r.upac_form_size) : undefined,
      upacFormUploadedAt: r.upac_form_uploaded_at ? String(r.upac_form_uploaded_at) : undefined,
      deletedAt: r.deleted_at ? String(r.deleted_at) : undefined,
      deletedBy: r.deleted_by ? String(r.deleted_by) : undefined,
      createdAt: String(r.created_at || ''),
      updatedAt: String(r.updated_at || ''),
      createdBy: r.created_by ? String(r.created_by) : undefined,
      updatedBy: r.updated_by ? String(r.updated_by) : undefined,
      history: parsedHistory,
    };
  }

  getLogs(): LogEntry[] {
    const res = this.sqlite.exec('SELECT * FROM logs WHERE deleted_at IS NULL ORDER BY log_no ASC');
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map((row) => this.rowToLog(row, cols));
  }

  private logNoTaken(no: number, exceptId?: string): boolean {
    const res = this.sqlite.exec('SELECT 1 FROM logs WHERE log_no = ? AND (? IS NULL OR id <> ?) LIMIT 1', [no, exceptId ?? null, exceptId ?? null]);
    return res.length > 0 && res[0].values.length > 0;
  }

  getNextLogNo(): number {
    const res = this.sqlite.exec('SELECT MAX(log_no) FROM logs');
    const maxVal = res[0]?.values[0]?.[0];
    return (Number(maxVal) || 0) + 1;
  }

  saveLog(entry: LogEntry, user: AppUser, existingId?: string, opts: { quiet?: boolean } = {}): LogEntry {
    // A log save also updates secondary columns, attachments, suggestions and audit activity. Keep all database
    // changes atomic; nested calls (bulk/import) reuse their caller's transaction.
    return this.transaction(() => this.saveLogUnsafe(entry, user, existingId, opts));
  }

  private saveLogUnsafe(entry: LogEntry, user: AppUser, existingId?: string, opts: { quiet?: boolean } = {}): LogEntry {
    const now = new Date().toISOString();
    const id = existingId || entry.id || crypto.randomUUID();
    // Keep a hand-picked category; auto-detect from the institute name when it is empty.
    entry = { ...entry, category: stripCategoryNumber(entry.category) || resolveCategory(entry) };
    // `undefined` can't be bound; a missing optional value is stored as NULL.
    const clean = (a: any[]) => a.map((v) => (v === undefined ? null : v));

    // Check if exists
    const checkRes = this.sqlite.exec('SELECT * FROM logs WHERE id = ?', [id]);
    const existingRow = checkRes.length && checkRes[0].values.length ? this.rowToLog(checkRes[0].values[0], checkRes[0].columns) : null;

    let saved: LogEntry;

    if (existingRow) {
      if (existingRow.deletedAt) {
        throw new Error('This connection is in the Bin and can only be restored by an administrator.');
      }
      if (Number(entry.logNo) !== Number(existingRow.logNo) && this.logNoTaken(Number(entry.logNo), existingRow.id)) {
        throw new Error(`Connection number ${entry.logNo} is already used by another connection.`);
      }
      const history = [...(existingRow.history || [])];
      const changes: { field: string; from: string; to: string }[] = [];
      const fieldsToCheck: (keyof LogEntry)[] = [
        'foremanName', 'requestType', 'customerName', 'nmsId',
        'issueFound', 'missingWrongDetails', 'actionTaken', 'reasonForAction',
        'foremanInformed', 'followUpNeeded', 'status', 'supervisorInformed',
        'remarks', 'mac', 'edcNo', 'emisEiinDghs', 'routerSerial', 'formReceivedAt', 'billReceivedAt', 'followUpDate',
        'foremanPhone', 'headTeacherName', 'headTeacherPhone', 'lat', 'long',
        'unionName', 'upazila', 'fiberLength', 'category', 'nameBn', 'nameEn',
      ];

      for (const f of fieldsToCheck) {
        if (f === 'formReceivedAt' || f === 'billReceivedAt') continue;
        const fromVal = String(existingRow[f] ?? '');
        const toVal = String(entry[f] ?? '');
        if (fromVal !== toVal) {
          changes.push({ field: f, from: fromVal, to: toVal });
        }
      }

      if (changes.length > 0) {
        history.push({ at: now, by: user.displayName, action: 'edited', changes });
      }

      saved = {
        ...existingRow,
        ...entry,
        id: existingRow.id,
        createdAt: existingRow.createdAt,
        createdBy: existingRow.createdBy,
        updatedAt: changes.length > 0 ? now : existingRow.updatedAt,
        updatedBy: changes.length > 0 ? user.displayName : existingRow.updatedBy,
        history,
        // Form / bill received marks only change through the approval flow (markLog), never through a normal save.
        formReceivedAt: existingRow.formReceivedAt,
        billReceivedAt: existingRow.billReceivedAt,
        billMonths: existingRow.billMonths,
      };

      this.sqlite.run(
        `UPDATE logs SET
          log_no = ?, date = ?, foreman_name = ?, caller_phone = ?, request_type = ?,
          customer_name = ?, nms_id = ?, issue_found = ?, missing_wrong_details = ?,
          action_taken = ?, reason_for_action = ?, foreman_informed = ?, follow_up_needed = ?,
          status = ?, supervisor_informed = ?, remarks = ?, mac = ?, edc_no = ?,
          router_serial = ?, form_received_at = ?, foreman_id = ?, follow_up_date = ?,
          foreman_phone = ?, head_teacher_name = ?, head_teacher_phone = ?,
          lat = ?, long = ?, union_name = ?, upazila = ?, fiber_length = ?, category = ?,
          updated_at = ?, updated_by = ?, history = ?
        WHERE id = ?`,
        clean([
          Number(saved.logNo), saved.date, saved.foremanName, null, saved.requestType,
          saved.customerName, saved.nmsId, saved.issueFound, saved.missingWrongDetails,
          saved.actionTaken, saved.reasonForAction, saved.foremanInformed, saved.followUpNeeded,
          saved.status, saved.supervisorInformed, saved.remarks, saved.mac, saved.edcNo || null,
          saved.routerSerial || null, saved.formReceivedAt || null, saved.foremanId || null, saved.followUpDate || null,
          saved.foremanPhone || null, saved.headTeacherName || null, saved.headTeacherPhone || null,
          saved.lat || null, saved.long || null, saved.unionName || null, saved.upazila || null, saved.fiberLength || null,
          saved.category || null,
          saved.updatedAt, saved.updatedBy || null, JSON.stringify(saved.history || []), saved.id
        ])
      );

      if (changes.length > 0 && !opts.quiet) {
        this.addActivity({
          by: user.displayName,
          action: 'edited',
          logNo: saved.logNo,
          customer: saved.customerName,
          detail: changes.map(c => c.field).join(', '),
        });
      }
    } else {
      // The server owns the numbering: a number that is already taken (two people saving at the same moment, or a
      // number typed by hand) is replaced by the next free one instead of creating a duplicate.
      const wanted = Number(entry.logNo);
      const logNo = wanted > 0 && !this.logNoTaken(wanted) ? wanted : this.getNextLogNo();
      saved = {
        ...entry,
        date: entry.date || '',
        foremanName: entry.foremanName || '',
        requestType: entry.requestType || '',
        customerName: entry.customerName || '',
        status: entry.status || '',
        formReceivedAt: user.role === 'admin' ? entry.formReceivedAt : undefined,
        billReceivedAt: user.role === 'admin' ? entry.billReceivedAt : undefined,
        billMonths: user.role === 'admin' ? entry.billMonths : undefined,
        id,
        logNo,
        createdAt: now,
        updatedAt: now,
        createdBy: user.displayName,
        updatedBy: user.displayName,
        history: [{ at: now, by: user.displayName, action: 'created' }],
      };

      this.sqlite.run(
        `INSERT INTO logs (
          id, log_no, date, foreman_name, caller_phone, request_type, customer_name,
          nms_id, issue_found, missing_wrong_details, action_taken, reason_for_action,
          foreman_informed, follow_up_needed, status, supervisor_informed, remarks, mac,
          edc_no, router_serial, form_received_at, foreman_id, follow_up_date,
          foreman_phone, head_teacher_name, head_teacher_phone, lat, long, union_name, upazila, fiber_length, category,
          deleted_at, deleted_by, created_at, updated_at, created_by, updated_by, history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        clean([
          saved.id, Number(saved.logNo), saved.date, saved.foremanName, null,
          saved.requestType, saved.customerName, saved.nmsId, saved.issueFound,
          saved.missingWrongDetails, saved.actionTaken, saved.reasonForAction,
          saved.foremanInformed, saved.followUpNeeded, saved.status, saved.supervisorInformed,
          saved.remarks, saved.mac, saved.edcNo || null, saved.routerSerial || null,
          saved.formReceivedAt || null, saved.foremanId || null, saved.followUpDate || null,
          saved.foremanPhone || null, saved.headTeacherName || null, saved.headTeacherPhone || null,
          saved.lat || null, saved.long || null, saved.unionName || null, saved.upazila || null, saved.fiberLength || null,
          saved.category || null,
          null, null, saved.createdAt, saved.updatedAt, saved.createdBy || null, saved.updatedBy || null,
          JSON.stringify(saved.history || [])
        ])
      );

      this.addActivity({
        by: user.displayName,
        action: 'created',
        logNo: saved.logNo,
        customer: saved.customerName,
      });
    }

    this.writeExtras(saved);
    this.harvestSuggestions(saved);
    this.notify('logs', { id: saved.id, action: existingRow ? 'updated' : 'created' });
    return saved;
  }

  private writeExtras(l: Partial<LogEntry> & { id: string }) {
    // Attached form: a name means "keep/attach", an empty name means "remove". New bytes (data) are
    // stored as a file; when no bytes are sent the existing file is left exactly as it is.
    const upacName = (l.upacFormName || '').trim();
    let upacSize: number | null = l.upacFormSize !== undefined && l.upacFormSize !== null ? l.upacFormSize : null;
    let upacType: string | null = null;
    if (!upacName) {
      this.removeAttachment(l.id);
      upacSize = null;
    } else if (l.upacFormData) {
      const stored = this.storeAttachment(l.id, l.upacFormData);
      upacSize = stored.size;
      upacType = stored.type;
    } else {
      // No new file: keep the type that was recorded when the file was stored (never trust one sent by the browser).
      const prev = this.sqlite.exec('SELECT upac_form_type FROM logs WHERE id = ?', [l.id]);
      const t = prev.length && prev[0].values.length ? prev[0].values[0][0] : null;
      upacType = t && SAFE_ATTACHMENT_TYPES.has(String(t)) ? String(t) : null;
    }
    this.sqlite.run(
      `UPDATE logs SET head_teacher_name = ?, head_teacher_phone = ?, lat = ?, long = ?, union_name = ?, upazila = ?,
         fiber_length = ?, category = ?, name_bn = ?, name_en = ?, foreman_phone = ?, bill_received_at = ?, bill_months = ?,
         upac_form_name = ?, upac_form_type = ?, upac_form_size = ?, upac_form_uploaded_at = ?,
         emis_eiin_dghs = ? WHERE id = ?`,
      [
        l.headTeacherName || null, l.headTeacherPhone || null, l.lat || null, l.long || null, l.unionName || null,
        l.upazila || null, l.fiberLength || null, l.category || null, l.nameBn || null, l.nameEn || null,
        l.foremanPhone || null, l.billReceivedAt || null,
        l.billMonths && l.billMonths.length ? JSON.stringify([...new Set(l.billMonths)].sort()) : null,
        upacName || null, upacName ? upacType : null,
        upacSize,
        upacName ? (l.upacFormUploadedAt || null) : null,
        l.emisEiinDghs || null,
        l.id,
      ]
    );
  }

  /** Validates the file, stores it as a file named by its hash, and points the log's attachment row at it. */
  private storeAttachment(logId: string, data: string): { size: number; type: string } {
    const bytes = decodeAttachment(data);
    if (bytes.length === 0) throw new Error('The attached file is empty.');
    if (bytes.length > ATTACH_MAX_BYTES) throw new Error('The attached form is larger than 20 MB.');
    const type = sniffAttachment(bytes);
    if (!type) throw new Error('The attached file is not a PDF, image (JPG/PNG) or Word document.');
    const { sha256, size } = writeBlob(DB_DIR, bytes);
    // read the file back from disk before the database is told it exists
    const back = readBlob(DB_DIR, sha256);
    if (!back || back.length !== size) throw new Error('Could not save the attached form.');
    this.sqlite.run('INSERT OR REPLACE INTO attachments (log_id, sha256, size, created_at) VALUES (?, ?, ?, ?)', [logId, sha256, size, new Date().toISOString()]);
    return { size, type };
  }

  /** Detaches the form. The file itself stays on disk until no database row and no kept backup refers to it (the nightly job removes it then). */
  private removeAttachment(logId: string) {
    this.sqlite.run('DELETE FROM attachments WHERE log_id = ?', [logId]);
  }

  setUpacForm(logId: string, form: { name: string; data: string; type?: string; size?: number }, user: AppUser): LogEntry {
    const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [logId]);
    if (!res.length || !res[0].values.length) throw new Error('Connection not found.');
    const log = this.rowToLog(res[0].values[0], res[0].columns);

    const now = new Date().toISOString();
    const upacFormName = form.name.trim();
    const storedFile = this.storeAttachment(logId, form.data);
    const upacFormType = storedFile.type;
    const upacFormSize = storedFile.size;
    const upacFormUploadedAt = now;

    this.sqlite.run(
      'UPDATE logs SET upac_form_name = ?, upac_form_type = ?, upac_form_size = ?, upac_form_uploaded_at = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      [upacFormName, upacFormType, upacFormSize, upacFormUploadedAt, now, user.displayName, logId]
    );

    this.addActivity({
      by: user.displayName,
      action: 'edited',
      logNo: log.logNo,
      customer: log.customerName,
      detail: `Attached UPAC form: ${upacFormName}`,
    });

    this.notify('logs', { id: logId, action: 'updated' });
    this.flush();

    return {
      ...log,
      upacFormName,
      upacFormType,
      upacFormSize,
      upacFormUploadedAt,
      updatedAt: now,
      updatedBy: user.displayName,
    };
  }

  deleteUpacForm(logId: string, user: AppUser): LogEntry {
    const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [logId]);
    if (!res.length || !res[0].values.length) throw new Error('Connection not found.');
    const log = this.rowToLog(res[0].values[0], res[0].columns);
    const oldName = log.upacFormName || 'form';

    const now = new Date().toISOString();
    this.sqlite.run(
      'UPDATE logs SET upac_form_name = NULL, upac_form_type = NULL, upac_form_size = NULL, upac_form_uploaded_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?',
      [now, user.displayName, logId]
    );
    this.removeAttachment(logId);

    this.addActivity({
      by: user.displayName,
      action: 'edited',
      logNo: log.logNo,
      customer: log.customerName,
      detail: `Removed UPAC form: ${oldName}`,
    });

    this.notify('logs', { id: logId, action: 'updated' });
    this.flush();

    const updated = { ...log };
    delete updated.upacFormName;
    delete updated.upacFormType;
    delete updated.upacFormSize;
    delete updated.upacFormUploadedAt;
    updated.updatedAt = now;
    updated.updatedBy = user.displayName;
    return updated;
  }

  getUpacForm(logId: string): { name: string; buffer: Buffer; type?: string; size?: number } | null {
    const res = this.sqlite.exec('SELECT upac_form_name, upac_form_type, upac_form_size FROM logs WHERE id = ?', [logId]);
    if (!res.length || !res[0].values.length) return null;
    const [name, type, size] = res[0].values[0];
    const ref = this.sqlite.get<{ sha256: string; size: number }>('SELECT sha256, size FROM attachments WHERE log_id = ?', [logId]);
    if (!ref || !isSha(ref.sha256)) return null;
    let buffer: Buffer | null = null;
    try {
      buffer = readBlob(DB_DIR, ref.sha256);
    } catch (err) {
      console.error('[Pace IT]', err);
      return null;
    }
    if (!buffer) {
      console.error(`[Pace IT] The file of an attached form is missing from disk (${ref.sha256}). Restore it from a backup.`);
      return null;
    }
    return {
      name: String(name || 'upac_form.pdf'),
      buffer,
      type: type && SAFE_ATTACHMENT_TYPES.has(String(type)) ? String(type) : 'application/octet-stream',
      size: size !== null && size !== undefined ? Number(size) : buffer.length,
    };
  }

  patchLog(id: string, fields: Partial<LogEntry>, user: AppUser): LogEntry | null {
    const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!res.length || !res[0].values.length) return null;
    const current = this.rowToLog(res[0].values[0], res[0].columns);
    // never let a patch rewrite identity / audit fields
    const { id: _i, createdAt: _c, createdBy: _cb, updatedAt: _u, updatedBy: _ub, history: _h, deletedAt: _d, deletedBy: _db, ...safe } = fields as any;
    const saved = this.saveLog({ ...current, ...safe }, user, id, { quiet: true });
    this.flush();
    return saved;
  }

  bulkFillField(field: string, items: { id: string; value: string }[], user: AppUser): { updated: number; unchanged: number; missing: number } {
    const labels: Record<string, string> = {
      mac: 'MAC address', routerSerial: 'Router serial', edcNo: 'EDC book no.', emisEiinDghs: 'EMIS / EIIN / DGHS', lat: 'Latitude', long: 'Longitude',
      fiberLength: 'Fiber length', unionName: 'Union / address', upazila: 'Upazila', headTeacherName: 'Head teacher name',
      headTeacherPhone: 'Head teacher phone', nameBn: 'Institute name (Bangla)', nameEn: 'Institute name (English)', remarks: 'Remarks',
    };
    if (!Object.prototype.hasOwnProperty.call(labels, field)) throw new Error('This field cannot be filled in bulk.');

    const result = this.transaction(() => {
      let updated = 0, unchanged = 0, missing = 0;
      for (const item of items) {
        const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [String(item?.id ?? '')]);
        if (!res.length || !res[0].values.length) { missing++; continue; }
        const current = this.rowToLog(res[0].values[0], res[0].columns);
        const value = String(item.value ?? '').trim().slice(0, 500);
        if (String((current as any)[field] ?? '') === value) { unchanged++; continue; }

        const patch: Partial<LogEntry> = { [field]: value };
        if (field === 'nameBn' || field === 'nameEn') {
          // customerName is the name shown everywhere: Bangla first, then English
          const bn = field === 'nameBn' ? value : (current.nameBn || '');
          const en = field === 'nameEn' ? value : (current.nameEn || '');
          patch.customerName = bn.trim() || en.trim() || current.customerName;
        }
        this.saveLog({ ...current, ...patch }, user, current.id, { quiet: true });
        updated++;
      }
      return { updated, unchanged, missing };
    });
    if (result.updated) {
      this.addActivity({ by: user.displayName, action: 'edited', detail: `Bulk fill - ${labels[field]}: ${result.updated} connection${result.updated === 1 ? '' : 's'}` });
      this.flush();
    }
    return result;
  }

  /** Set every connection's upazila to the one the target workbook gives its EDC number. Returns how many changed. */
  syncUpazilasToTargets(by = 'System', onlyIds?: string[]): number {
    const only = onlyIds ? new Set(onlyIds.map(String)) : null;
    const map = targetUpazilaMap();
    if (!map.size) return 0;
    const res = this.sqlite.exec('SELECT id, edc_no, upazila, history FROM logs WHERE deleted_at IS NULL AND edc_no IS NOT NULL');
    if (!res.length) return 0;
    const now = new Date().toISOString();
    let n = 0;
    this.sqlite.run('BEGIN');
    try {
      for (const [id, edc, upa, hist] of res[0].values) {
        if (only && !only.has(String(id))) continue;
        const want = map.get(edcNorm(edc));
        if (!want || String(upa ?? '') === want) continue;
        let history: any[] = [];
        try { history = hist ? JSON.parse(String(hist)) : []; } catch { history = []; }
        history.push({ at: now, by, action: 'edited', changes: [{ field: 'upazila', from: String(upa ?? ''), to: want }] });
        this.sqlite.run('UPDATE logs SET upazila = ?, history = ? WHERE id = ?', [want, JSON.stringify(history), String(id)]);
        n++;
      }
      this.sqlite.run('COMMIT');
    } catch (e) { this.sqlite.run('ROLLBACK'); throw e; }
    if (n) {
      console.log(`[Pace IT] Upazila synced to the target workbook for ${n} connection(s).`);
      this.notify('logs', { action: 'updated' });
    }
    return n;
  }

  bulkSetTerm(ids: string[], term: string, user: AppUser): { updated: number; unchanged: number; missing: number } {
    const t = String(term || '').trim().slice(0, 40);
    let updated = 0, unchanged = 0, missing = 0;
    const now = new Date().toISOString();
    this.sqlite.run('BEGIN');
    try {
      for (const rawId of ids) {
        const res = this.sqlite.exec('SELECT term FROM logs WHERE id = ? AND deleted_at IS NULL', [String(rawId ?? '')]);
        if (!res.length || !res[0].values.length) { missing++; continue; }
        const had = String(res[0].values[0][0] ?? '');
        if (had === t) { unchanged++; continue; }
        this.sqlite.run('UPDATE logs SET term = ?, updated_at = ?, updated_by = ? WHERE id = ?', [t || null, now, user.displayName, String(rawId)]);
        updated++;
      }
      this.sqlite.run('COMMIT');
    } catch (e) { this.sqlite.run('ROLLBACK'); throw e; }
    if (updated) {
      this.notify('logs', { action: 'updated' });
      this.addActivity({ by: user.displayName, action: 'edited', detail: `Marked ${updated} connection${updated === 1 ? '' : 's'} as ${t || 'no term'}` });
      this.flush();
    }
    return { updated, unchanged, missing };
  }

  bulkSetForeman(ids: string[], foremanId: string, user: AppUser): { updated: number; unchanged: number; missing: number; foremanName: string } {
    const foremen = this.getForemen();
    const f = foremen.find((x) => x.id === foremanId);
    if (!f) throw new Error('Foreman not found.');
    if (!f.active) throw new Error(`${f.name} is marked inactive.`);
    const logName = foremanLogName(f, foremen);

    const result = this.transaction(() => {
      let updated = 0, unchanged = 0, missing = 0;
      for (const rawId of ids) {
        const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [String(rawId ?? '')]);
        if (!res.length || !res[0].values.length) { missing++; continue; }
        const cur = this.rowToLog(res[0].values[0], res[0].columns);

        // the foreman's upazila becomes the log's upazila; an "own broadband" foreman keeps the
        // customer's upazila when he is allowed to supply it
        const curUpa = upazilaKey(cur.upazila);
        const upazila = f.roam && curUpa && foremanServes(f, curUpa) ? curUpa : upazilaKey(f.area) || cur.upazila || '';
        // keep a phone typed by hand on the log; otherwise use the new foreman's
        const prev = cur.foremanId ? foremen.find((x) => x.id === cur.foremanId) : undefined;
        const foremanPhone = cur.foremanPhone?.trim() && cur.foremanPhone !== prev?.phone ? cur.foremanPhone : f.phone || '';

        if (cur.foremanId === f.id && cur.foremanName === logName && (cur.upazila || '') === upazila && (cur.foremanPhone || '') === foremanPhone) {
          unchanged++;
          continue;
        }
        this.saveLog({ ...cur, foremanId: f.id, foremanName: logName, upazila, foremanPhone }, user, cur.id, { quiet: true });
        updated++;
      }
      return { updated, unchanged, missing };
    });
    if (result.updated) {
      this.addActivity({ by: user.displayName, action: 'edited', detail: `Changed foreman to ${logName}: ${result.updated} connection${result.updated === 1 ? '' : 's'}` });
      this.flush();
    }
    return { ...result, foremanName: logName };
  }

  // Form / bill received marks and the admin approval queue
  private rowToApproval(r: SqlValue[]): ApprovalRequest {
    const [id, logId, logNo, customer, kind, action, requestedBy, requestedAt, status, decidedBy, decidedAt, month, receivedOn, requestedById] = r;
    return {
      id: String(id), logId: String(logId), logNo: logNo ? String(logNo) : undefined,
      customer: customer ? String(customer) : undefined, kind: kind as MarkKind, action: action as MarkAction,
      requestedBy: String(requestedBy), requestedById: requestedById ? String(requestedById) : undefined,
      requestedAt: String(requestedAt), status: status as ApprovalRequest['status'],
      decidedBy: decidedBy ? String(decidedBy) : undefined, decidedAt: decidedAt ? String(decidedAt) : undefined,
      month: month ? String(month) : undefined,
      receivedOn: receivedOn ? String(receivedOn) : undefined,
    };
  }

  listApprovals(): ApprovalRequest[] {
    const cols = 'id, log_id, log_no, customer, kind, action, requested_by, requested_at, status, decided_by, decided_at, month, received_on, requested_by_id';
    const pending = this.sqlite.exec(`SELECT ${cols} FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC`);
    const done = this.sqlite.exec(`SELECT ${cols} FROM approvals WHERE status <> 'pending' ORDER BY decided_at DESC LIMIT 100`);
    return [
      ...(pending.length ? pending[0].values.map((r) => this.rowToApproval(r)) : []),
      ...(done.length ? done[0].values.map((r) => this.rowToApproval(r)) : []),
    ];
  }

  private monthOf(at?: string | null): string {
    const d = at ? new Date(at) : new Date();
    const x = isNaN(d.getTime()) ? new Date() : d;
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
  }

  private cleanMonth(m: unknown, fallbackAt?: string): string {
    return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : this.monthOf(fallbackAt);
  }

  private stampOf(dateStr: unknown, fallback: string): string {
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const d = new Date(`${dateStr}T12:00:00.000Z`);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    return fallback;
  }

  private applyMark(logId: string, kind: MarkKind, action: MarkAction, at: string, by: string, month?: string, receivedOn?: string): boolean {
    const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [logId]);
    if (!res.length || !res[0].values.length) return false;
    const current = this.rowToLog(res[0].values[0], res[0].columns);
    const m = this.cleanMonth(month, at);
    const now = new Date().toISOString();
    let change: { field: string; from: string; to: string };

    if (kind === 'bill') {
      const had = current.billMonths || [];
      const next = action === 'received' ? [...new Set([...had, m])].sort() : had.filter((x) => x !== m);
      if (next.join(',') === had.join(',')) return true;
      // billReceivedAt = when the latest bill came in (empty once no month is left)
      const stamp = next.length ? (action === 'received' ? at : current.billReceivedAt || at) : '';
      this.sqlite.run('UPDATE logs SET bill_months = ?, bill_received_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        next.length ? JSON.stringify(next) : null, stamp || null, now, by, logId,
      ]);
      change = { field: 'billMonths', from: had.join(', '), to: next.join(', ') };
    } else {
      const from = String(current.formReceivedAt ?? '');
      const to = action === 'received' ? this.stampOf(receivedOn, at) : '';
      // Already in that state. Two received dates differ only when a form is moved to another month.
      if (from && to ? from === to : !!from === !!to) return true;
      this.sqlite.run('UPDATE logs SET form_received_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', [to || null, now, by, logId]);
      change = { field: 'formReceivedAt', from, to };
    }
    const history = [...(current.history || []), { at: now, by, action: 'edited' as const, changes: [change] }];
    this.sqlite.run('UPDATE logs SET history = ? WHERE id = ?', [JSON.stringify(history), logId]);
    return true;
  }

  requestMarks(items: { logId: string; kind: MarkKind; action: MarkAction; month?: string; receivedOn?: string; move?: boolean }[], user: AppUser): { applied: number; queued: number; skipped: number } {
    const now = new Date().toISOString();
    const result = this.transaction(() => {
      let applied = 0, queued = 0, skipped = 0;
      for (const it of items) {
        if ((it.kind !== 'form' && it.kind !== 'bill') || (it.action !== 'received' && it.action !== 'not_received')) { skipped++; continue; }
        const res = this.sqlite.exec('SELECT * FROM logs WHERE id = ? AND deleted_at IS NULL', [it.logId]);
        if (!res.length || !res[0].values.length) { skipped++; continue; }
        const log = this.rowToLog(res[0].values[0], res[0].columns);
        const month = it.kind === 'bill' ? this.cleanMonth(it.month) : null;
        const receivedOn = it.kind === 'form' && typeof it.receivedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.receivedOn) ? it.receivedOn : null;
        const currentlyReceived = it.kind === 'bill' ? (log.billMonths || []).includes(month as string) : Boolean(log.formReceivedAt);
        if (it.kind === 'bill') this.sqlite.run("DELETE FROM approvals WHERE log_id = ? AND kind = 'bill' AND status = 'pending' AND COALESCE(month, '') = ?", [it.logId, month]);
        else this.sqlite.run("DELETE FROM approvals WHERE log_id = ? AND kind = 'form' AND status = 'pending'", [it.logId]);
        // A form that is already received can be moved to another month (it.move): that is a new received date.
        const movesForm = it.kind === 'form' && it.action === 'received' && currentlyReceived && Boolean(it.move) && Boolean(receivedOn);
        if (currentlyReceived === (it.action === 'received') && !movesForm) { skipped++; continue; }
        if (user.role === 'admin') {
          this.applyMark(it.logId, it.kind, it.action, now, user.displayName, month ?? undefined, receivedOn ?? undefined);
          applied++;
        } else {
          this.sqlite.run(
            "INSERT INTO approvals (id, log_id, log_no, customer, kind, action, requested_by, requested_at, status, month, received_on, requested_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
            [crypto.randomUUID(), it.logId, String(log.logNo ?? ''), String(log.customerName ?? ''), it.kind, it.action, user.displayName, now, month, receivedOn, user.id]
          );
          queued++;
        }
      }
      return { applied, queued, skipped };
    });
    if (result.applied) this.notify('logs');
    this.notify('approvals');
    this.flush();
    return result;
  }

  decideApprovals(opts: { ids?: string[]; all?: boolean; approve: boolean }, user: AppUser): { approved: number; rejected: number } {
    const want = opts.all ? null : new Set(opts.ids || []);
    const now = new Date().toISOString();
    const result = this.transaction(() => {
      const res = this.sqlite.exec("SELECT id, log_id, kind, action, requested_at, month, received_on FROM approvals WHERE status = 'pending'");
      const rows = res.length ? res[0].values : [];
      let approved = 0, rejected = 0;
      for (const [id, logId, kind, action, requestedAt, month, receivedOn] of rows) {
        if (want && !want.has(String(id))) continue;
        if (opts.approve) {
          const done = this.applyMark(String(logId), kind as MarkKind, action as MarkAction, String(requestedAt), user.displayName, month ? String(month) : undefined, receivedOn ? String(receivedOn) : undefined);
          if (done) {
            this.sqlite.run("UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [user.displayName, now, String(id)]);
            approved++;
          } else {
            // The log was deleted after the request was sent: nothing to apply, so close it as rejected.
            this.sqlite.run("UPDATE approvals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [user.displayName, now, String(id)]);
            rejected++;
          }
        } else {
          this.sqlite.run("UPDATE approvals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [user.displayName, now, String(id)]);
          rejected++;
        }
      }
      return { approved, rejected };
    });
    if (result.approved) {
      this.addActivity({ by: user.displayName, action: 'edited', detail: `${result.approved} form/bill request(s) approved` });
      this.notify('logs');
    }
    this.notify('approvals');
    this.flush();
    return result;
  }

  withdrawApproval(id: string, user: AppUser): boolean {
    const res = this.sqlite.exec("SELECT requested_by, requested_by_id FROM approvals WHERE id = ? AND status = 'pending'", [id]);
    if (!res.length || !res[0].values.length) return false;
    const [by, byId] = res[0].values[0];
    const mine = byId ? String(byId) === user.id : String(by) === user.displayName;
    if (user.role !== 'admin' && !mine) return false;
    this.sqlite.run('DELETE FROM approvals WHERE id = ?', [id]);
    this.notify('approvals');
    this.flush();
    return true;
  }

  // CSV import requests: a normal user's import waits here until an admin approves it
  createImportRequest(entries: LogEntry[], user: AppUser): ImportRequest {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sample = entries.slice(0, 3).map((e) => String(e.customerName || e.nmsId || '').trim()).filter(Boolean).join(' · ');
    this.sqlite.run(
      "INSERT INTO import_requests (id, requested_by, requested_by_id, requested_at, status, entry_count, sample, payload) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      [id, user.displayName, user.id, now, entries.length, sample, JSON.stringify(entries.map((e) => upgradeLegacyLog(e)))]
    );
    this.addActivity({ by: user.displayName, action: 'edited', detail: `Requested CSV import of ${entries.length} connection${entries.length === 1 ? '' : 's'} (waiting for admin)` });
    this.notify('imports');
    this.flush();
    return { id, requestedBy: user.displayName, requestedAt: now, status: 'pending', count: entries.length, sample };
  }

  listImportRequests(): ImportRequest[] {
    const cols = 'id, requested_by, requested_at, status, decided_by, decided_at, entry_count, sample, requested_by_id';
    const map = (r: SqlValue[]): ImportRequest => ({
      id: String(r[0]), requestedBy: String(r[1]), requestedAt: String(r[2]), status: r[3] as ImportRequest['status'],
      decidedBy: r[4] ? String(r[4]) : undefined, decidedAt: r[5] ? String(r[5]) : undefined,
      count: Number(r[6] || 0), sample: r[7] ? String(r[7]) : undefined,
      requestedById: r[8] ? String(r[8]) : undefined,
    });
    const pending = this.sqlite.exec(`SELECT ${cols} FROM import_requests WHERE status = 'pending' ORDER BY requested_at ASC`);
    const done = this.sqlite.exec(`SELECT ${cols} FROM import_requests WHERE status <> 'pending' ORDER BY decided_at DESC LIMIT 20`);
    return [
      ...(pending.length ? pending[0].values.map(map) : []),
      ...(done.length ? done[0].values.map(map) : []),
    ];
  }

  decideImportRequest(id: string, approve: boolean, admin: AppUser): { status: 'approved' | 'rejected'; saved: number } {
    const res = this.sqlite.exec("SELECT requested_by, payload FROM import_requests WHERE id = ? AND status = 'pending'", [id]);
    if (!res.length || !res[0].values.length) throw new Error('This import request is no longer pending.');
    const [requestedBy, payload] = res[0].values[0];
    const now = new Date().toISOString();
    // Importing and closing the request happen together: a bad row leaves the request pending and
    // the logs untouched, so approving again never creates duplicates.
    const saved = this.transaction(() => {
      let n = 0;
      if (approve) {
        const entries: LogEntry[] = (JSON.parse(String(payload || '[]')) as LogEntry[]).map((e) => upgradeLegacyLog(e));
        // The log keeps the name of the person who asked for the import.
        const asRequester: AppUser = { ...admin, displayName: String(requestedBy) };
        n = this.saveBatchLogs(entries, asRequester).length;
      }
      this.sqlite.run("UPDATE import_requests SET status = ?, decided_by = ?, decided_at = ?, payload = NULL WHERE id = ?", [approve ? 'approved' : 'rejected', admin.displayName, now, id]);
      return n;
    });
    this.addActivity({
      by: admin.displayName, action: approve ? 'created' : 'edited',
      detail: approve ? `Approved CSV import by ${requestedBy}: ${saved} connection${saved === 1 ? '' : 's'}` : `Rejected CSV import by ${requestedBy}`,
    });
    this.notify('imports');
    this.flush();
    return { status: approve ? 'approved' : 'rejected', saved };
  }

  withdrawImportRequest(id: string, user: AppUser): boolean {
    const res = this.sqlite.exec("SELECT requested_by_id FROM import_requests WHERE id = ? AND status = 'pending'", [id]);
    if (!res.length || !res[0].values.length) return false;
    if (user.role !== 'admin' && String(res[0].values[0][0]) !== user.id) return false;
    this.sqlite.run('DELETE FROM import_requests WHERE id = ?', [id]);
    this.notify('imports');
    this.flush();
    return true;
  }

  private transactionDepth = 0;
  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.sqlite.run('BEGIN');
    this.transactionDepth++;
    try {
      const out = fn();
      this.sqlite.run('COMMIT');
      return out;
    } catch (err) {
      try { this.sqlite.run('ROLLBACK'); } catch { /* nothing to undo */ }
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  saveBatchLogs(entries: LogEntry[], user: AppUser): LogEntry[] {
    return this.transaction(() => this.saveBatchLogsUnsafe(entries, user));
  }

  private saveBatchLogsUnsafe(entries: LogEntry[], user: AppUser): LogEntry[] {
    let nextNo = this.getNextLogNo();
    const savedList: LogEntry[] = [];
    for (const entry of entries) {
      const logNo = entry.logNo || nextNo++;
      const saved = this.saveLog({ ...entry, logNo }, user);
      savedList.push(saved);
    }
    return savedList;
  }

  softDeleteLog(id: string, user: AppUser): boolean {
    const res = this.sqlite.exec('SELECT log_no, customer_name FROM logs WHERE id = ?', [id]);
    if (!res.length || !res[0].values.length) return false;
    const [logNo, customerName] = res[0].values[0];

    const now = new Date().toISOString();
    this.sqlite.run('UPDATE logs SET deleted_at = ?, deleted_by = ? WHERE id = ?', [now, user.displayName, id]);

    this.addActivity({
      by: user.displayName,
      action: 'deleted',
      logNo: Number(logNo),
      customer: String(customerName || ''),
    });

    this.notify('logs');
    return true;
  }

  softDeleteAllLogs(user: AppUser): number {
    const now = new Date().toISOString();
    const countRes = this.sqlite.exec('SELECT COUNT(*) FROM logs WHERE deleted_at IS NULL');
    const count = Number(countRes[0]?.values[0]?.[0] || 0);

    if (count > 0) {
      this.sqlite.run('UPDATE logs SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL', [now, user.displayName]);
      this.addActivity({
        by: user.displayName,
        action: 'cleared',
        detail: `All ${count} connections moved to admin bin`,
      });
      this.notify('logs');
    }
    return count;
  }

  restoreLogs(imported: LogEntry[], merge: boolean, user: AppUser): number {
    return this.transaction(() => this.restoreLogsUnsafe(imported, merge, user)); // all or nothing
  }

  private restoreLogsUnsafe(imported: LogEntry[], merge: boolean, user: AppUser): number {
    const now = new Date().toISOString();
    if (!merge) {
      this.sqlite.run('UPDATE logs SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL', [now, user.displayName]);
    }

    for (const rawItem of imported) {
      const item = upgradeLegacyLog(rawItem);
      const id = item.id || crypto.randomUUID();
      const logNo = Number(item.logNo || 1);
      const historyJson = Array.isArray(item.history) ? JSON.stringify(item.history) : '[]';

      this.sqlite.run(
        `INSERT OR REPLACE INTO logs (
          id, log_no, date, foreman_name, foreman_phone, request_type, customer_name,
          nms_id, issue_found, missing_wrong_details, action_taken, reason_for_action,
          foreman_informed, follow_up_needed, status, supervisor_informed, remarks, mac,
          edc_no, router_serial, form_received_at, foreman_id, follow_up_date,
          deleted_at, deleted_by, created_at, updated_at, created_by, updated_by, history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, logNo, String(item.date || ''), String(item.foremanName || ''),
          String(item.foremanPhone || (item as any).callerPhone || ''), String(item.requestType || ''),
          String(item.customerName || ''), String(item.nmsId || ''),
          String(item.issueFound || ''), String(item.missingWrongDetails || ''),
          String(item.actionTaken || ''), String(item.reasonForAction || ''),
          String(item.foremanInformed || ''), String(item.followUpNeeded || ''),
          String(item.status || 'Resolved'), String(item.supervisorInformed || ''),
          String(item.remarks || ''), String(item.mac || ''), item.edcNo || null,
          item.routerSerial || null, item.formReceivedAt || null, item.foremanId || null,
          item.followUpDate || null, null, null,
          String(item.createdAt || now), String(item.updatedAt || now),
          item.createdBy || user.displayName, item.updatedBy || user.displayName,
          historyJson
        ]
      );
      // An old backup file only carries the form's name, never its bytes. A name without a stored file would be a dead link.
      const hasFile = Boolean(item.upacFormData) || Number(this.sqlite.scalar('SELECT COUNT(*) FROM attachments WHERE log_id = ?', [id]) || 0) > 0;
      this.writeExtras({ ...item, id, upacFormName: hasFile ? item.upacFormName : '' });
      // Fields the shared writer does not cover: the term, and the received marks exactly as they were in the file.
      this.sqlite.run('UPDATE logs SET term = ?, form_received_at = ?, bill_received_at = ? WHERE id = ?', [
        item.term || null, item.formReceivedAt || null, item.billReceivedAt || null, id,
      ]);
      this.harvestSuggestions(item);
    }

    this.addActivity({
      by: user.displayName,
      action: 'restored',
      detail: `${imported.length} connections imported (${merge ? 'merged' : 'replaced'})`,
    });

    this.notify('logs');
    const cnt = this.sqlite.exec('SELECT COUNT(*) FROM logs WHERE deleted_at IS NULL');
    return Number(cnt[0]?.values[0]?.[0] || 0);
  }

  // Foremen
  getForemen(): Foreman[] {
    const res = this.sqlite.exec('SELECT id, name, area, phone, active, created_at, deleted_at, deleted_by, photo_url, roam, roam_areas FROM foremen WHERE deleted_at IS NULL ORDER BY name ASC');
    if (!res.length) return [];
    return res[0].values.map(([id, name, area, phone, active, createdAt, deletedAt, deletedBy, photoUrl, roam, roamAreas]) => ({
      id: String(id),
      name: String(name),
      area: String(area || ''),
      phone: String(phone || ''),
      photoUrl: photoUrl ? String(photoUrl) : undefined,
      active: Number(active) === 1,
      roam: Number(roam) === 1,
      roamAreas: parseRoamAreas(roamAreas),
      createdAt: String(createdAt),
      deletedAt: deletedAt ? String(deletedAt) : undefined,
      deletedBy: deletedBy ? String(deletedBy) : undefined,
    }));
  }

  createForeman(input: { name: string; area?: string; phone?: string; photoUrl?: string }, _user: AppUser): Foreman {
    const name = input.name.trim();
    if (!name) throw new Error('Foreman name is required.');
    const area = upazilaKey(input.area);
    if (!area) throw new Error('Please choose the foreman\'s upazila.');

    const check = this.sqlite.exec(
      'SELECT id, area FROM foremen WHERE lower(name) = ? AND deleted_at IS NULL',
      [name.toLowerCase()]
    );
    if (check.length && check[0].values.some((v) => upazilaKey(String(v[1] || '')) === area)) {
      throw new Error(`${name} already exists in ${area}.`);
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const phone = (input.phone || '').trim();
    const photoUrl = cleanPhotoUrl(input.photoUrl);

    this.sqlite.run(
      'INSERT INTO foremen (id, name, area, phone, active, created_at, photo_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, area, phone, 1, createdAt, photoUrl || null]
    );

    this.notify('foremen');
    return { id, name, area, phone, photoUrl: photoUrl || undefined, active: true, createdAt };
  }

  updateForeman(id: string, input: { name?: string; area?: string; phone?: string; active?: boolean; photoUrl?: string; roam?: boolean; roamAreas?: string[] }): Foreman {
    const cur = this.sqlite.exec('SELECT id, name, area, phone, active, created_at, photo_url, roam, roam_areas FROM foremen WHERE id = ?', [id]);
    if (!cur.length || !cur[0].values.length) throw new Error('Foreman not found.');

    const [, curName, curArea, curPhone, curActive, createdAt, curPhotoUrl, curRoam, curRoamAreas] = cur[0].values[0];
    const newName = input.name !== undefined ? input.name.trim() : String(curName);
    let newArea = String(curArea || '');
    if (input.area !== undefined) {
      const key = upazilaKey(input.area);
      if (!key) throw new Error('Please choose the foreman\'s upazila.');
      newArea = key;
    }
    const newPhone = input.phone !== undefined ? input.phone.trim() : String(curPhone || '');
    const newActive = input.active !== undefined ? (input.active ? 1 : 0) : Number(curActive);
    const newPhotoUrl = input.photoUrl !== undefined ? cleanPhotoUrl(input.photoUrl) : (curPhotoUrl ? String(curPhotoUrl) : '');

    if (!newName) throw new Error('Foreman name is required.');
    const dup = this.sqlite.exec(
      'SELECT id, area FROM foremen WHERE lower(name) = ? AND id <> ? AND deleted_at IS NULL',
      [newName.toLowerCase(), id]
    );
    if (dup.length && dup[0].values.some((v) => upazilaKey(String(v[1] || '')) === newArea)) {
      throw new Error(`${newName} already exists in ${newArea}.`);
    }

    const newRoam = input.roam !== undefined ? (input.roam ? 1 : 0) : Number(curRoam) === 1 ? 1 : 0;
    const newRoamAreas = input.roamAreas !== undefined
      ? Array.from(new Set(input.roamAreas.map((a) => upazilaKey(a)).filter(Boolean)))
      : parseRoamAreas(curRoamAreas);

    this.sqlite.run(
      'UPDATE foremen SET name = ?, area = ?, phone = ?, active = ?, photo_url = ?, roam = ?, roam_areas = ? WHERE id = ?',
      [newName, newArea, newPhone, newActive, newPhotoUrl || null, newRoam, newRoamAreas.join(',') || null, id]
    );
    if (newName !== String(curName)) {
      // Keep every connection of the old name: logs keep a copy of the name, so carry them over.
      // 1) logs already linked to this foreman
      this.sqlite.run('UPDATE logs SET foreman_name = ? WHERE foreman_id = ?', [newName, id]);
      // 2) older logs that only stored the name (no link yet): claim them and link them to this foreman
      const oldLc = String(curName).trim().toLowerCase();
      const sameNameOthers = this.sqlite.exec(
        'SELECT COUNT(*) FROM foremen WHERE lower(trim(name)) = ? AND id <> ? AND deleted_at IS NULL',
        [oldLc, id]
      );
      const hasTwin = Number(sameNameOthers[0]?.values[0]?.[0] || 0) > 0;
      if (!hasTwin) {
        this.sqlite.run(
          "UPDATE logs SET foreman_name = ?, foreman_id = ? WHERE (foreman_id IS NULL OR foreman_id = '') AND lower(trim(foreman_name)) = ?",
          [newName, id, oldLc]
        );
      } else {
        // another foreman shares the old name: only claim name-only logs from this foreman's own upazila
        this.sqlite.run(
          "UPDATE logs SET foreman_name = ?, foreman_id = ? WHERE (foreman_id IS NULL OR foreman_id = '') AND lower(trim(foreman_name)) = ? AND upazila = ?",
          [newName, id, oldLc, newArea]
        );
      }
    }

    this.notify('foremen');
    return { id, name: newName, area: newArea, phone: newPhone, photoUrl: newPhotoUrl || undefined, active: newActive === 1, roam: newRoam === 1, roamAreas: newRoamAreas, createdAt: String(createdAt) };
  }

  softDeleteForeman(id: string, user: AppUser): boolean {
    const now = new Date().toISOString();
    this.sqlite.run('UPDATE foremen SET deleted_at = ?, deleted_by = ? WHERE id = ?', [now, user.displayName, id]);
    this.notify('foremen');
    return true;
  }

  // Foreman teams (members working under a foreman)
  private rowToTeamMember(row: SqlValue[]): TeamMember {
    const [id, foremanId, name, phone, role, active, createdAt, deletedAt, deletedBy] = row;
    return {
      id: String(id),
      foremanId: String(foremanId),
      name: String(name),
      phone: String(phone || ''),
      role: String(role || ''),
      active: Number(active) === 1,
      createdAt: String(createdAt),
      deletedAt: deletedAt ? String(deletedAt) : undefined,
      deletedBy: deletedBy ? String(deletedBy) : undefined,
    };
  }

  private static readonly TEAM_COLS = 'id, foreman_id, name, phone, role, active, created_at, deleted_at, deleted_by';

  getTeamMembers(): TeamMember[] {
    const res = this.sqlite.exec(`SELECT ${SQLiteDatabase.TEAM_COLS} FROM team_members WHERE deleted_at IS NULL ORDER BY name ASC`);
    if (!res.length) return [];
    return res[0].values.map((row) => this.rowToTeamMember(row));
  }

  createTeamMember(input: { foremanId: string; name: string; phone?: string; role?: string }, _user: AppUser): TeamMember {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Team member name is required.');
    const foremanId = String(input.foremanId || '');
    const rs = this.sqlite.exec('SELECT id FROM foremen WHERE id = ? AND deleted_at IS NULL', [foremanId]);
    if (!rs.length || !rs[0].values.length) throw new Error('Please choose the foreman this team member works under.');

    const dup = this.sqlite.exec(
      'SELECT id FROM team_members WHERE foreman_id = ? AND lower(name) = ? AND deleted_at IS NULL',
      [foremanId, name.toLowerCase()]
    );
    if (dup.length && dup[0].values.length) throw new Error(`${name} is already in this foreman's team.`);

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const phone = String(input.phone || '').trim();
    const role = String(input.role || '').trim();
    this.sqlite.run(
      'INSERT INTO team_members (id, foreman_id, name, phone, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [id, foremanId, name, phone, role, createdAt]
    );
    this.notify('foremen');
    return { id, foremanId, name, phone, role, active: true, createdAt };
  }

  updateTeamMember(id: string, input: { name?: string; phone?: string; role?: string; active?: boolean }): TeamMember {
    const cur = this.sqlite.exec(`SELECT ${SQLiteDatabase.TEAM_COLS} FROM team_members WHERE id = ?`, [id]);
    if (!cur.length || !cur[0].values.length) throw new Error('Team member not found.');
    const m = this.rowToTeamMember(cur[0].values[0]);

    const name = input.name !== undefined ? input.name.trim() : m.name;
    if (!name) throw new Error('Team member name is required.');
    const phone = input.phone !== undefined ? input.phone.trim() : m.phone;
    const role = input.role !== undefined ? input.role.trim() : m.role;
    const active = input.active !== undefined ? input.active : m.active;

    const dup = this.sqlite.exec(
      'SELECT id FROM team_members WHERE foreman_id = ? AND lower(name) = ? AND id <> ? AND deleted_at IS NULL',
      [m.foremanId, name.toLowerCase(), id]
    );
    if (dup.length && dup[0].values.length) throw new Error(`${name} is already in this foreman's team.`);

    this.sqlite.run('UPDATE team_members SET name = ?, phone = ?, role = ?, active = ? WHERE id = ?', [name, phone, role, active ? 1 : 0, id]);
    this.notify('foremen');
    return { ...m, name, phone, role, active };
  }

  softDeleteTeamMember(id: string, user: AppUser): boolean {
    this.sqlite.run('UPDATE team_members SET deleted_at = ?, deleted_by = ? WHERE id = ?', [new Date().toISOString(), user.displayName, id]);
    this.notify('foremen');
    return true;
  }

  // Admin Bin
  getBin(): { logs: LogEntry[]; foremen: Foreman[] } {
    const logRes = this.sqlite.exec('SELECT * FROM logs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    const logs = logRes.length ? logRes[0].values.map(r => this.rowToLog(r, logRes[0].columns)) : [];

    const resRes = this.sqlite.exec('SELECT id, name, area, phone, active, created_at, deleted_at, deleted_by FROM foremen WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    const foremen = resRes.length ? resRes[0].values.map(([id, name, area, phone, active, createdAt, deletedAt, deletedBy]) => ({
      id: String(id),
      name: String(name),
      area: String(area || ''),
      phone: String(phone || ''),
      active: Number(active) === 1,
      createdAt: String(createdAt),
      deletedAt: deletedAt ? String(deletedAt) : undefined,
      deletedBy: deletedBy ? String(deletedBy) : undefined,
    })) : [];

    return { logs, foremen };
  }

  restoreBinLog(id: string): boolean {
    this.sqlite.run('UPDATE logs SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', [id]);
    this.notify('logs');
    return true;
  }

  restoreBinForeman(id: string): boolean {
    this.sqlite.run('UPDATE foremen SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', [id]);
    this.notify('foremen');
    return true;
  }

  purgeBinLog(id: string, user: AppUser): boolean {
    // Only an item that really is in the bin can be removed for good.
    const res = this.sqlite.exec('SELECT log_no, customer_name FROM logs WHERE id = ? AND deleted_at IS NOT NULL', [id]);
    if (!res.length || !res[0].values.length) return false;
    const [logNo, customerName] = res[0].values[0];
    this.sqlite.run('DELETE FROM logs WHERE id = ? AND deleted_at IS NOT NULL', [id]);
    this.sqlite.run('DELETE FROM attachments WHERE log_id = ?', [id]);
    this.addActivity({ by: user.displayName, action: 'purged', logNo: Number(logNo), customer: String(customerName || ''), detail: 'Permanently deleted from the bin' });
    this.notify('logs');
    return true;
  }

  purgeBinForeman(id: string, user: AppUser): boolean {
    const res = this.sqlite.exec('SELECT name FROM foremen WHERE id = ? AND deleted_at IS NOT NULL', [id]);
    if (!res.length || !res[0].values.length) return false;
    this.sqlite.run('DELETE FROM foremen WHERE id = ? AND deleted_at IS NOT NULL', [id]);
    this.addActivity({ by: user.displayName, action: 'purged', detail: `Foreman ${String(res[0].values[0][0])} permanently deleted from the bin` });
    this.notify('foremen');
    return true;
  }

  emptyBin(user: AppUser): number {
    const countLogs = Number(this.sqlite.scalar('SELECT COUNT(*) FROM logs WHERE deleted_at IS NOT NULL') || 0);
    const countForemen = Number(this.sqlite.scalar('SELECT COUNT(*) FROM foremen WHERE deleted_at IS NOT NULL') || 0);

    this.sqlite.run('DELETE FROM attachments WHERE log_id IN (SELECT id FROM logs WHERE deleted_at IS NOT NULL)');
    this.sqlite.run('DELETE FROM logs WHERE deleted_at IS NOT NULL');
    this.sqlite.run('DELETE FROM foremen WHERE deleted_at IS NOT NULL');

    if (countLogs + countForemen > 0) this.addActivity({ by: user.displayName, action: 'purged', detail: `Bin emptied: ${countLogs} connection(s) and ${countForemen} foreman/foremen permanently deleted` });
    this.notify('logs');
    this.notify('foremen');
    return countLogs + countForemen;
  }

  // Suggestions
  getSuggestions(): FieldSuggestionsMap {
    const res = this.sqlite.exec('SELECT field, values_json FROM suggestions');
    const map: FieldSuggestionsMap = { ...INITIAL_SUGGESTIONS };
    if (res.length) {
      for (const [field, valuesJson] of res[0].values) {
        try {
          const parsed = JSON.parse(String(valuesJson));
          if (Array.isArray(parsed)) {
            map[field as LogFieldKey] = parsed;
          }
        } catch {
          /* ignore */
        }
      }
    }
    // Legacy: the old "callerPhone" suggestions now belong to foreman phone
    const legacy = (map as Record<string, string[]>)['callerPhone'];
    if (legacy) {
      const merged = [...(map.foremanPhone || [])];
      for (const v of legacy) if (!merged.includes(v)) merged.push(v);
      map.foremanPhone = merged;
      delete (map as Record<string, string[]>)['callerPhone'];
    }
    return map;
  }

  saveSuggestions(suggestions: FieldSuggestionsMap) {
    for (const [field, values] of Object.entries(suggestions)) {
      this.sqlite.run('INSERT OR REPLACE INTO suggestions (field, values_json) VALUES (?, ?)', [
        field,
        JSON.stringify(values),
      ]);
    }
    this.notify('suggestions');
  }

  harvestSuggestions(entry: Partial<LogEntry>): FieldSuggestionsMap {
    const current = this.getSuggestions();
    const keys: LogFieldKey[] = [
      'foremanName', 'foremanPhone', 'requestType', 'customerName', 'nmsId',
      'issueFound', 'missingWrongDetails', 'actionTaken', 'reasonForAction',
      'foremanInformed', 'followUpNeeded', 'status', 'supervisorInformed',
      'remarks', 'mac'
    ];

    let changed = false;
    for (const key of keys) {
      const val = String(entry[key] || '').trim();
      if (!val) continue;
      const existing = current[key] || [];
      if (!existing.some(x => x.toLowerCase() === val.toLowerCase())) {
        current[key] = [val, ...existing];
        this.sqlite.run('INSERT OR REPLACE INTO suggestions (field, values_json) VALUES (?, ?)', [
          key,
          JSON.stringify(current[key]),
        ]);
        changed = true;
      }
    }

    if (changed) {
      this.notify('suggestions');
    }
    return current;
  }

  // Activity
  getActivity(): ActivityEvent[] {
    const res = this.sqlite.exec('SELECT id, at, by_user, action, log_no, customer, detail FROM activity ORDER BY at DESC LIMIT 200');
    if (!res.length) return [];
    return res[0].values.map(([id, at, by, action, logNo, customer, detail]) => ({
      id: String(id),
      at: String(at),
      by: String(by),
      action: action as any,
      logNo: logNo ? String(logNo) : undefined,
      customer: customer ? String(customer) : undefined,
      detail: detail ? String(detail) : undefined,
    }));
  }

  addActivity(event: Omit<ActivityEvent, 'id' | 'at'>) {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    this.sqlite.run(
      'INSERT INTO activity (id, at, by_user, action, log_no, customer, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, at, event.by, event.action, event.logNo ? String(event.logNo) : null, event.customer || null, event.detail || null]
    );
    this.notify('activity', { id, at, ...event });
  }


  // ---------------------------------------------------------------------------------------------------------
  // Settings, storage migration, full backup / restore and wipe
  //
  // Everything the app stores lives in the SQLite database: connections, foremen, team members, approvals,
  // import requests, saved field values, the activity feed, user accounts, the security log, the targets list,
  // attached forms and settings. The full backup, the restore and the wipe all work from the list of tables in
  // the database itself, so a table added in the future is covered automatically.
  // ---------------------------------------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const res = this.sqlite.exec('SELECT value FROM settings WHERE key = ?', [key]);
    return res.length && res[0].values.length && res[0].values[0][0] !== null ? String(res[0].values[0][0]) : null;
  }

  setSetting(key: string, value: string) {
    this.sqlite.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }

  /** Settings the browser may read and change (flags used by the server itself are not listed). */
  getPublicSettings(): { formOverdueDays: number } {
    const n = parseInt(this.getSetting('form_overdue_days') || '', 10);
    return { formOverdueDays: Number.isFinite(n) && n > 0 && n < 365 ? n : 3 };
  }

  setFormOverdueDays(n: number) {
    if (!Number.isInteger(n) || n < 1 || n > 364) throw new Error('Enter a whole number of days between 1 and 364.');
    this.setSetting('form_overdue_days', String(n));
    this.notify('settings');
  }

  private targetsVersion = 0;

  private registerTargets() {
    registerTargetStore({
      load: () => {
        const res = this.sqlite.exec('SELECT data FROM targets ORDER BY position ASC');
        if (!res.length) return [];
        const out: unknown[] = [];
        for (const [data] of res[0].values) { try { out.push(JSON.parse(String(data))); } catch { /* skip a damaged row */ } }
        return out;
      },
      save: (list) => {
        const raw = this.sqlite.raw;
        raw.exec('BEGIN IMMEDIATE');
        try {
          raw.exec('DELETE FROM targets');
          const ins = raw.prepare('INSERT INTO targets (position, data) VALUES (?, ?)');
          list.forEach((t, i) => ins.run(i, JSON.stringify(t)));
          raw.exec('COMMIT');
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* nothing open */ }
          throw err;
        }
        this.targetsVersion++;
      },
      version: () => this.targetsVersion,
    });
  }

  private userTables(): string[] {
    const res = this.sqlite.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return res.length ? res[0].values.map((v) => String(v[0])) : [];
  }

  private tableColumns(table: string): string[] {
    const res = this.sqlite.exec(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);
    return res.length ? res[0].values.map((v) => String(v[1])) : [];
  }

  private countRows(table: string): number {
    return Number(this.sqlite.scalar(`SELECT COUNT(*) FROM "${table.replace(/"/g, '""')}"`) || 0);
  }

  /** A consistent copy of the whole database, kept in data/backups before anything destructive happens. (The database holds metadata only; attached forms are files that a restore or wipe never deletes.) */
  private async snapshot(label: string): Promise<string> {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `pace_it-${label}-${stamp}.sqlite`);
    const tmp = `${file}.tmp`;
    snapshotDb(SQLITE_FILE, tmp);
    try {
      verifySnapshot(tmp);
    } catch (e: any) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`The safety copy failed its check, so nothing was changed. (${e?.message || e})`);
    }
    fs.renameSync(tmp, file);
    // keep the newest five safety copies of each kind
    const mine = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(`pace_it-${label}-`) && f.endsWith('.sqlite')).sort().reverse();
    for (const f of mine.slice(5)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* in use */ } }
    return path.basename(file);
  }

  /**
   * Everything in the database as one JSON-friendly object. Every table is dumped in full (soft-deleted rows, the
   * activity feed, the security log, password hashes, attached forms as base64). Login sessions are left out.
   */
  exportFull(): FullBackup {
    // This format puts every attached form inside one JSON text in memory. Beyond a few hundred MB use `npm run backup`.
    const formBytes = Number(this.sqlite.scalar('SELECT COALESCE(SUM(size), 0) FROM attachments') || 0);
    if (formBytes > 200 * 1048576) throw new RangeError('too big for a single backup file');
    const tables: FullBackup['tables'] = {};
    const counts: Record<string, number> = {};
    for (const table of this.userTables()) {
      if (table === 'sessions') continue;
      if (table === 'attachments') {
        // the forms travel inside the file (base64) and are written back to disk by restoreFull
        const rows = this.sqlite.all<{ log_id: string; sha256: string; size: number }>('SELECT log_id, sha256, size FROM attachments').map((r) => {
          const bytes = readBlob(DB_DIR, r.sha256);
          if (!bytes) throw new Error(`An attached form is missing on disk (connection ${r.log_id}). The backup was not made.`);
          return [r.log_id, r.sha256, r.size, { $b64: bytes.toString('base64') }];
        });
        tables[table] = { columns: ['log_id', 'sha256', 'size', 'data'], rows };
        counts[table] = rows.length;
        continue;
      }
      const res = this.sqlite.exec(`SELECT * FROM "${table}"`);
      const columns = this.tableColumns(table);
      const rows = res.length
        ? res[0].values.map((row) => row.map((v) => (v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v)))
        : [];
      tables[table] = { columns, rows };
      counts[table] = rows.length;
    }
    return { format: FULL_BACKUP_FORMAT, version: 5, appName: 'Pace IT', exportedAt: new Date().toISOString(), counts, tables };
  }

  /** Checks an uploaded full backup and returns it ready to load. Throws before safety-copy/restore writes begin. */
  private validateFullBackup(input: unknown): FullBackup {
    const knownTables = this.userTables();
    const columnsByTable = Object.fromEntries(knownTables.map((table) => [table, this.tableColumns(table)]));
    return validateFullBackupShape(input, { knownTables, columnsByTable }) as unknown as FullBackup;
  }

  /** Inside restoreFull's transaction: replaces the attachment rows and writes each form's bytes back to disk. Returns the row count. */
  private restoreAttachmentRows(t: { columns: string[]; rows: unknown[][] }): number {
    const col = (name: string) => t.columns.indexOf(name);
    const iLog = col('log_id'), iData = col('data'), iSha = col('sha256'), iSize = col('size');
    this.sqlite.run('DELETE FROM attachments');
    const now = new Date().toISOString();
    let n = 0;
    for (const row of t.rows) {
      const logId = String(row[iLog]);
      const v: any = iData >= 0 ? row[iData] : null;
      let sha = iSha >= 0 && isSha(row[iSha]) ? String(row[iSha]) : '';
      let size = iSize >= 0 ? Number(row[iSize]) : 0;
      if (v && typeof v === 'object' && typeof v.$b64 === 'string') {
        const bytes = Buffer.from(v.$b64, 'base64'); // new and old backup files both carry the bytes this way
        if (!bytes.length) throw new Error(`The backup has an empty attached form (connection ${logId}).`);
        if (sha && sha256Of(bytes) !== sha) throw new Error(`The backup is damaged (attached form of connection ${logId} does not match its checksum).`);
        const w = writeBlob(DB_DIR, bytes);
        sha = w.sha256;
        size = w.size;
      } else if (!sha || !fs.existsSync(blobPath(blobRoot(DB_DIR), sha))) {
        throw new Error(`The backup has no data for the attached form of connection ${logId}.`);
      }
      this.sqlite.run('INSERT INTO attachments (log_id, sha256, size, created_at) VALUES (?, ?, ?, ?)', [logId, sha, size, now]);
      n++;
    }
    return n;
  }

  /** Replaces the entire database with the contents of a full backup. All or nothing; a safety copy is kept first. */
  async restoreFull(input: unknown, user: AppUser): Promise<{ counts: Record<string, number>; safetyCopy: string }> {
    const backup = this.validateFullBackup(input);
    const safetyCopy = await this.snapshot('before-restore');
    const raw = this.sqlite.raw;
    const known = this.userTables().filter((t) => t !== 'sessions');
    const counts: Record<string, number> = {};
    if (this.getMaintenance()) throw new Error('The system went into maintenance (backup in progress). Nothing was changed. Try again in a few minutes.');
    raw.exec('BEGIN IMMEDIATE');
    try {
      for (const table of known) {
        const t = (backup.tables as any)[table];
        if (!t) continue; // this backup predates the table: leave it as it is
        if (table === 'attachments') {
          counts[table] = this.restoreAttachmentRows(t);
          continue;
        }
        const have = new Set(this.tableColumns(table));
        const idx: number[] = [];
        const cols: string[] = [];
        t.columns.forEach((c: unknown, i: number) => { if (typeof c === 'string' && have.has(c)) { idx.push(i); cols.push(c); } });
        raw.exec(`DELETE FROM "${table}"`);
        if (!cols.length) { counts[table] = 0; continue; }
        const ins = raw.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const row of t.rows) {
          ins.run(...idx.map((i) => {
            const v = row[i];
            if (v && typeof v === 'object' && typeof (v as any).$b64 === 'string') return Buffer.from((v as any).$b64, 'base64');
            return v === undefined ? null : v;
          }) as any[]);
        }
        const now = this.countRows(table);
        if (now !== t.rows.length) throw new Error(`Restore check failed for "${table}" (${now} of ${t.rows.length} rows).`);
        counts[table] = now;
      }
      // The restored data is the whole truth: nothing may be re-created from the old defaults or files.
      this.setSetting('foremen_seeded', '1');
      raw.exec('COMMIT');
    } catch (err) {
      try { raw.exec('ROLLBACK'); } catch { /* nothing open */ }
      throw err;
    }
    // Sessions of accounts that are not in the restored data must not survive.
    this.sqlite.run('DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)');
    this.targetsVersion++;
    this.revision++;
    for (const type of ['logs', 'foremen', 'approvals', 'imports', 'suggestions', 'activity', 'users', 'settings']) this.notify(type);
    this.addActivity({ by: user.displayName, action: 'restored', detail: `Full backup restored (${counts.logs ?? 0} connections, ${counts.foremen ?? 0} foremen, ${counts.activity ?? 0} activity entries)` });
    return { counts, safetyCopy };
  }

  /**
   * Deletes everything that was entered into the app: connections (including the bin), bills and forms, foremen and
   * teams, approvals, import requests, saved values, the activity feed, targets, attached forms and settings.
   * Only the user accounts and the security log are kept, so you can still sign in and see who wiped what.
   */
  async wipeAll(): Promise<{ removed: Record<string, number>; safetyCopy: string }> {
    const safetyCopy = await this.snapshot('before-wipe');
    const keep = new Set(['users', 'sessions', 'security_events']);
    const wipe = this.userTables().filter((t) => !keep.has(t));
    const removed: Record<string, number> = {};
    const raw = this.sqlite.raw;
    if (this.getMaintenance()) throw new Error('The system went into maintenance (backup in progress). Nothing was changed. Try again in a few minutes.');
    raw.exec('BEGIN IMMEDIATE');
    try {
      for (const t of wipe) {
        removed[t] = this.countRows(t);
        raw.exec(`DELETE FROM "${t}"`);
        if (this.countRows(t) !== 0) throw new Error(`Could not empty "${t}".`);
      }
      this.setSetting('foremen_seeded', '1'); // an empty directory must stay empty after a restart
      raw.exec('COMMIT');
    } catch (err) {
      try { raw.exec('ROLLBACK'); } catch { /* nothing open */ }
      throw err;
    }
    // Give the freed space back and drop the deleted content from the database file itself, not just from the tables.
    // (Attached-form files stay on disk until the nightly clean-up finds that no kept backup needs them any more.)
    try { raw.exec('VACUUM'); raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (err) { console.error('[Pace IT] VACUUM after wipe failed:', err); }
    this.targetsVersion++;
    this.revision++;
    for (const type of ['logs', 'foremen', 'approvals', 'imports', 'suggestions', 'activity', 'settings']) this.notify(type);
    return { removed, safetyCopy };
  }

  seedAllForemen() {
    const list: { name: string; area: string; phone: string }[] = [
      { name: 'Salam', area: 'Bishwanath', phone: '+880 1712-238545' },
      { name: 'Shuhag', area: 'Beanibazar', phone: '+880 1805-983971' },
      { name: 'Shabul', area: 'Balaganj', phone: '+880 1680-945894' },
      { name: 'Jubayer', area: 'Dakshin Surma', phone: '+880 1748-075240' },
      { name: 'Joshim', area: 'Sylhet Sadar', phone: '+880 1713-476562' },
      { name: 'Jamal', area: 'Zakiganj', phone: '+880 1745-963663' },
      { name: 'Munna', area: 'Sylhet Sadar', phone: '+880 1713-476556' },
      { name: 'Liton', area: 'Sylhet Sadar', phone: '' },
      { name: 'Sultan', area: 'Zakiganj', phone: '' },
      { name: 'Jakir', area: 'Beanibazar', phone: '' },
      { name: 'Javed', area: 'Beanibazar', phone: '' },
      { name: 'Al-amin', area: 'Golapganj', phone: '' },
      { name: 'Mrinal', area: 'Sylhet Sadar', phone: '' },
      { name: 'Kawsar', area: 'Zakiganj', phone: '' },
      { name: 'Monir', area: 'Zakiganj', phone: '' },
      { name: 'Masud', area: 'Beanibazar', phone: '' },
      { name: 'Kuddus', area: 'Beanibazar', phone: '' },
      { name: 'Iqbal', area: 'Beanibazar', phone: '' },
      { name: 'Kalam', area: 'Sylhet Sadar', phone: '' },
      { name: 'Shahel', area: 'Dakshin Surma', phone: '' },
      { name: 'Evan', area: 'Sylhet Sadar', phone: '' },
      { name: 'Khairul', area: 'Jaintiapur', phone: '' },
      { name: 'Nahim', area: 'Kanaighat', phone: '' },
      { name: 'Rubel', area: 'Osmani Nagar', phone: '' },
      { name: 'Rupok', area: 'Zakiganj', phone: '' },
      { name: 'Washim', area: 'Dakshin Surma', phone: '' },
      { name: 'Kashem', area: 'Beanibazar', phone: '' },
      { name: 'Razon', area: 'Sylhet Sadar', phone: '' },
      { name: 'Raton', area: 'Fenchuganj', phone: '' },
      { name: 'Raihan', area: 'Companiganj', phone: '' },
      { name: 'Faisal', area: 'Zakiganj', phone: '' },
      { name: 'Mustaiem', area: 'Golapganj', phone: '' },
      { name: 'Joinal', area: 'Golapganj', phone: '' },
      { name: 'Syed', area: 'Beanibazar', phone: '' },
      { name: 'Faruk', area: 'Fenchuganj', phone: '' },
      { name: 'Anowar', area: 'Zakiganj', phone: '' },
      { name: 'Mursalin', area: 'Fenchuganj', phone: '' },
      { name: 'Sohag-Ahmed', area: 'Beanibazar', phone: '' },
      { name: 'Hassan', area: 'Gowainghat', phone: '' },
      { name: 'Uzzal', area: 'Beanibazar', phone: '' },
      { name: 'Shahab', area: 'Beanibazar', phone: '' },
      { name: 'Nojmul', area: 'Beanibazar', phone: '' },
      { name: 'Zia', area: 'Beanibazar', phone: '' },
      { name: 'Monjur', area: 'Kanaighat', phone: '' },
      { name: 'Ruhel', area: 'Dakshin Surma', phone: '' },
    ];

    // Only seed a brand-new database. Seeding on every start would bring back old names
    // (e.g. a foreman renamed from Jamal to Kalam would reappear as Jamal).
    // A wipe or a restore also sets this flag, so an emptied directory stays empty after a restart.
    if (this.getSetting('foremen_seeded') === '1') return;
    const existing = Number(this.sqlite.scalar('SELECT COUNT(*) FROM foremen') || 0);
    if (existing > 0) { this.setSetting('foremen_seeded', '1'); return; }
    this.setSetting('foremen_seeded', '1');

    const now = new Date().toISOString();
    let addedCount = 0;
    for (const item of list) {
      const area = upazilaKey(item.area) || item.area;
      const check = this.sqlite.exec('SELECT id, area, phone FROM foremen WHERE lower(name) = ?', [item.name.toLowerCase()]);
      if (check.length && check[0].values.length) {
        const [id, exArea, exPhone] = check[0].values[0];
        const newArea = exArea ? String(exArea) : area;
        const newPhone = exPhone ? String(exPhone) : item.phone;
        this.sqlite.run('UPDATE foremen SET area = ?, phone = ? WHERE id = ?', [newArea, newPhone, id]);
      } else {
        const id = crypto.randomUUID();
        this.sqlite.run(
          'INSERT INTO foremen (id, name, area, phone, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
          [id, item.name, area, item.phone || '', now]
        );
        addedCount++;
      }
    }
    if (addedCount > 0) {
      console.log(`[Pace IT] Seeded ${addedCount} new foremen into database.`);
    }
  }
}

export const db = new SQLiteDatabase();

// Never lose the last few changes when the server is stopped (Ctrl+C, service stop, window closed).
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
process.on('SIGHUP', shutdown); // console window closed
process.on('exit', () => {
  try {
    db.close();
  } catch {
    /* nothing more to do */
  }
});

// One bad request or timer must not take the whole office offline. Log it and keep serving.
process.on('unhandledRejection', (reason) => { console.error('[Pace IT] Unhandled promise rejection (server keeps running):', reason); });
process.on('uncaughtException', (err) => { console.error('[Pace IT] Uncaught exception (server keeps running):', err); });
