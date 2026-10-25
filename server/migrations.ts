import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { blobPath, blobRoot, sha256Of, writeBlob } from './blobs';

// ONE ordered list of numbered migrations. Each runs exactly once, inside a transaction, and bumps
// PRAGMA user_version when it succeeds. A change to the database is a NEW ENTRY at the end of MIGRATIONS;
// never an `if` somewhere else and never an edit to an entry that has already shipped.
//
// Databases that were created before this list existed have user_version 6 (the old one-off steps 1-6 were
// already applied by earlier versions of the app). Migration 7 is the baseline: it makes sure every table, column
// and index exists, so it is safe on a brand-new file and on an existing database.

type Db = DatabaseSync;
export interface MigrationContext {
  dataDir: string;
  log: (msg: string) => void;
  /** set by a migration that freed a lot of space: the runner VACUUMs once at the end */
  needsVacuum: boolean;
}
export interface Migration {
  version: number;
  name: string;
  up: (db: Db, ctx: MigrationContext) => void;
}

const BASELINE_VERSION = 7;

function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function columnsOf(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}
function ensureColumns(db: Db, table: string, cols: [string, string][]): void {
  const have = columnsOf(db, table);
  for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

const BASELINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    phone_number TEXT,
    email TEXT,
    photo_url TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    log_no INTEGER NOT NULL,
    date TEXT NOT NULL,
    foreman_name TEXT NOT NULL,
    caller_phone TEXT,
    request_type TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    nms_id TEXT,
    issue_found TEXT,
    missing_wrong_details TEXT,
    action_taken TEXT,
    reason_for_action TEXT,
    foreman_informed TEXT,
    follow_up_needed TEXT,
    status TEXT NOT NULL,
    supervisor_informed TEXT,
    remarks TEXT,
    mac TEXT,
    edc_no TEXT,
    emis_eiin_dghs TEXT,
    router_serial TEXT,
    form_received_at TEXT,
    foreman_id TEXT,
    follow_up_date TEXT,
    foreman_phone TEXT,
    head_teacher_name TEXT,
    head_teacher_phone TEXT,
    lat TEXT,
    long TEXT,
    union_name TEXT,
    upazila TEXT,
    fiber_length TEXT,
    category TEXT,
    name_bn TEXT,
    name_en TEXT,
    bill_received_at TEXT,
    bill_months TEXT,
    term TEXT,
    upac_form_name TEXT,
    upac_form_data TEXT,
    upac_form_type TEXT,
    upac_form_size INTEGER,
    upac_form_uploaded_at TEXT,
    deleted_at TEXT,
    deleted_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT,
    updated_by TEXT,
    history TEXT
  );

  CREATE TABLE IF NOT EXISTS foremen (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    area TEXT,
    phone TEXT,
    photo_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    roam INTEGER NOT NULL DEFAULT 0,
    roam_areas TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    foreman_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    role TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    log_id TEXT NOT NULL,
    log_no TEXT,
    customer TEXT,
    kind TEXT NOT NULL,
    action TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decided_at TEXT,
    month TEXT,
    received_on TEXT,
    requested_by_id TEXT
  );

  CREATE TABLE IF NOT EXISTS import_requests (
    id TEXT PRIMARY KEY,
    requested_by TEXT NOT NULL,
    requested_by_id TEXT,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decided_at TEXT,
    entry_count INTEGER NOT NULL DEFAULT 0,
    sample TEXT,
    payload TEXT
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    field TEXT PRIMARY KEY,
    values_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    by_user TEXT NOT NULL,
    action TEXT NOT NULL,
    log_no TEXT,
    customer TEXT,
    detail TEXT
  );

  -- Login sessions. Only a keyed hash of the cookie value is stored, so a copy of the database cannot be used to sign in.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER
  );

  -- Security log: sign-ins, failed attempts, password changes, restores. Shown to the administrator only.
  CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    username TEXT,
    ip TEXT,
    detail TEXT
  );

  -- Small app-wide settings and one-time flags.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- The Targets tab list (one row per institute, kept in the order it was imported).
  CREATE TABLE IF NOT EXISTS targets (
    position INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );

  -- Attached forms. Migration 8 turns this into (log_id, sha256, size, created_at) with the bytes in files on disk.
  CREATE TABLE IF NOT EXISTS attachments (
    log_id TEXT PRIMARY KEY,
    data BLOB NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_deleted ON logs(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_logs_no ON logs(log_no);
  CREATE INDEX IF NOT EXISTS idx_logs_nms ON logs(nms_id);
  CREATE INDEX IF NOT EXISTS idx_logs_edc ON logs(edc_no);
  CREATE INDEX IF NOT EXISTS idx_logs_foreman ON logs(foreman_id);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
  CREATE INDEX IF NOT EXISTS idx_logs_upazila ON logs(upazila);
  CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
  CREATE INDEX IF NOT EXISTS idx_team_members_foreman ON team_members(foreman_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  CREATE INDEX IF NOT EXISTS idx_import_requests_status ON import_requests(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

/** Columns added over the years by ALTER TABLE. A database from any older version gets whatever it lacks. */
const BASELINE_COLUMNS: Record<string, [string, string][]> = {
  logs: [
    ['foreman_phone', 'TEXT'], ['head_teacher_name', 'TEXT'], ['head_teacher_phone', 'TEXT'], ['lat', 'TEXT'], ['long', 'TEXT'],
    ['union_name', 'TEXT'], ['upazila', 'TEXT'], ['fiber_length', 'TEXT'], ['category', 'TEXT'], ['name_bn', 'TEXT'], ['name_en', 'TEXT'],
    ['emis_eiin_dghs', 'TEXT'], ['bill_received_at', 'TEXT'], ['bill_months', 'TEXT'], ['term', 'TEXT'],
    ['upac_form_name', 'TEXT'], ['upac_form_data', 'TEXT'], ['upac_form_type', 'TEXT'], ['upac_form_size', 'INTEGER'], ['upac_form_uploaded_at', 'TEXT'],
  ],
  users: [['phone_number', 'TEXT'], ['email', 'TEXT'], ['photo_url', 'TEXT']],
  foremen: [['photo_url', 'TEXT'], ['roam', 'INTEGER NOT NULL DEFAULT 0'], ['roam_areas', 'TEXT']],
  approvals: [['month', 'TEXT'], ['received_on', 'TEXT'], ['requested_by_id', 'TEXT']],
  sessions: [['last_seen', 'INTEGER']],
};

export const MIGRATIONS: Migration[] = [
  {
    version: BASELINE_VERSION,
    name: 'baseline schema, indexes and one-time clean-ups of older data',
    up(db, ctx) {
      // A database older than version 6 still needs the old one-off data steps (renames, categories). Those were
      // removed from the code once every real database had passed them. Refuse instead of guessing.
      if (tableExists(db, 'logs')) {
        const n = Number((db.prepare('SELECT COUNT(*) AS c FROM logs').get() as any).c);
        const v = Number((db.prepare('PRAGMA user_version').get() as any).user_version);
        if (n > 0 && v < 6) {
          throw new Error('This database is from a much older version of Pace IT (it was never upgraded to schema 6). Open it once with the previous release of the app, then use this one.');
        }
      }
      db.exec(BASELINE_SCHEMA);
      for (const [table, cols] of Object.entries(BASELINE_COLUMNS)) ensureColumns(db, table, cols);

      // Older databases kept the institute name only in customer_name: copy it into the right-language field.
      for (const r of db.prepare("SELECT id, customer_name FROM logs WHERE (name_bn IS NULL OR name_bn = '') AND (name_en IS NULL OR name_en = '') AND customer_name <> ''").all() as { id: string; customer_name: string }[]) {
        const isBangla = /[ঀ-৿]/.test(r.customer_name);
        db.prepare(`UPDATE logs SET ${isBangla ? 'name_bn' : 'name_en'} = ? WHERE id = ?`).run(r.customer_name, r.id);
      }
      ctx.log('Database schema is up to date.');
    },
  },
  {
    version: 8,
    name: 'attached forms move out of the database into hash-named files',
    up(db, ctx) {
      if (columnsOf(db, 'attachments').has('sha256')) return; // already the new shape
      const ids = (db.prepare('SELECT log_id FROM attachments').all() as { log_id: string }[]).map((r) => r.log_id);
      const rows: { log_id: string; sha256: string; size: number }[] = [];
      const get = db.prepare('SELECT data FROM attachments WHERE log_id = ?');
      let skipped = 0;
      for (const id of ids) {
        const r = get.get(id) as { data: Uint8Array | null } | undefined;
        const bytes = r?.data ? Buffer.from(r.data) : null;
        if (!bytes || bytes.length === 0) { skipped++; continue; }
        const { sha256, size } = writeBlob(ctx.dataDir, bytes);
        // read it back from disk before the database row that held the only other copy is dropped
        const back = fs.readFileSync(blobPath(blobRoot(ctx.dataDir), sha256));
        if (back.length !== size || sha256Of(back) !== sha256) throw new Error(`Could not store the attached form of connection ${id} safely on disk. Nothing was changed.`);
        rows.push({ log_id: id, sha256, size });
      }
      db.exec(`CREATE TABLE attachments_new (
        log_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`);
      const ins = db.prepare('INSERT INTO attachments_new (log_id, sha256, size, created_at) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      for (const r of rows) ins.run(r.log_id, r.sha256, r.size, now);
      db.exec('DROP TABLE attachments');
      db.exec('ALTER TABLE attachments_new RENAME TO attachments');
      db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256)');
      ctx.needsVacuum = rows.length > 0;
      ctx.log(`Moved ${rows.length} attached form(s) out of the database into ${path.join(ctx.dataDir, 'files', 'blobs')}${skipped ? ` (${skipped} empty row(s) dropped)` : ''}.`);
    },
  },
  {
    version: 9,
    name: 'indexes for the tables that grow',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
        CREATE INDEX IF NOT EXISTS idx_approvals_log ON approvals(log_id);
        CREATE INDEX IF NOT EXISTS idx_approvals_requested ON approvals(requested_at);
        CREATE INDEX IF NOT EXISTS idx_security_events_at ON security_events(at);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_logs_updated ON logs(updated_at);
        CREATE INDEX IF NOT EXISTS idx_logs_form_received ON logs(form_received_at);
        CREATE INDEX IF NOT EXISTS idx_logs_bill_received ON logs(bill_received_at);
        CREATE INDEX IF NOT EXISTS idx_logs_follow_up ON logs(follow_up_date);
        CREATE INDEX IF NOT EXISTS idx_foremen_deleted ON foremen(deleted_at);
      `);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Copies the database next to itself before a migration touches real data. The two newest copies are kept. */
function safetyCopy(db: Db, dbFile: string, fromVersion: number, log: (m: string) => void): void {
  try {
    const dir = path.dirname(dbFile);
    const file = `${dbFile}.before-schema-${fromVersion}-${Date.now()}`;
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`${path.basename(dbFile)}.before-schema-`)).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - 2))) fs.rmSync(path.join(dir, f), { force: true });
    log(`A copy of the database as it was before the upgrade is at ${file}`);
  } catch (e: any) {
    log(`Could not make a pre-upgrade copy (${e?.message || e}). Continuing: every step runs in a transaction.`);
  }
}

/** Runs every migration newer than the database's user_version. Throws (and changes nothing) on the first failure. */
export function runMigrations(db: Db, dbFile: string, dataDir: string, log: (m: string) => void = console.log): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as any).user_version);
  if (current > LATEST_VERSION) {
    throw new Error(`This database is from a newer version of Pace IT (schema ${current}, this app understands up to ${LATEST_VERSION}). Update the app instead of opening it with this one.`);
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (!pending.length) return;
  const hasData = tableExists(db, 'logs') && Number((db.prepare('SELECT COUNT(*) AS c FROM logs').get() as any).c) > 0;
  if (hasData) safetyCopy(db, dbFile, current, log);
  const ctx: MigrationContext = { dataDir, log, needsVacuum: false };
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db, ctx);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      log(`[Pace IT] Database upgrade ${m.version} done: ${m.name}.`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
      throw new Error(`Database upgrade ${m.version} (${m.name}) failed and was undone: ${(err as any)?.message || err}`);
    }
  }
  if (ctx.needsVacuum) {
    try { db.exec('VACUUM'); } catch (e: any) { log(`[Pace IT] Could not shrink the database file after the upgrade (${e?.message || e}). Not a problem.`); }
  }
}
