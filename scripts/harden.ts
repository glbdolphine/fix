// One-time (and safe to repeat) security clean-up of a Pace IT data folder.
//   STOP THE SERVER FIRST, then run:   npm run harden
// What it does:
//   1. removes leftover copies of the database (data/pace_it.sqlite.before-*, interrupted *.tmp files),
//      but only when a newer, healthy backup exists
//   2. replaces the secret key and signs every user out (use this if any copy of the folder may have been shared)
//   3. restricts the data folder so only your Windows/Linux account can open it
//   4. warns about accounts that still use a default password
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';

const DATA = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const DB = path.join(DATA, 'pace_it.sqlite');
const KEY = path.join(DATA, 'pace_it_secret.key');
const BACKUPS = path.join(DATA, 'backups');
const say = (m: string) => console.log(m);
const die = (m: string): never => { console.error('\nSTOPPED: ' + m); process.exit(1); };

if (!fs.existsSync(DB)) die(`No database at ${DB}. Run this from the project folder, or set PACE_DATA_DIR.`);

// Refuse to run while the server is writing.
let db!: DatabaseSync;
try {
  db = new DatabaseSync(DB);
  db.exec('PRAGMA busy_timeout = 1500');
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
} catch {
  die('The database is in use. Stop the Pace IT server first, then run this again.');
}

// 1. leftovers -------------------------------------------------------------------------------------------
function countLogs(file: string): number {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return Number((d.prepare('SELECT COUNT(*) AS c FROM logs').get() as any).c); } finally { d.close(); }
}
/** A healthy backup that holds at least as many connections as the old copy, so nothing is lost by removing it. */
function healthyBackupCovering(oldFile: string): string | null {
  if (!fs.existsSync(BACKUPS)) return null;
  let need = 0;
  try { need = countLogs(oldFile); } catch { need = 0; }
  const files = fs.readdirSync(BACKUPS).filter((f) => /\.sqlite$/.test(f)).sort().reverse();
  for (const f of files) {
    const p = path.join(BACKUPS, f);
    try {
      const b = new DatabaseSync(p, { readOnly: true });
      const ok = (b.prepare('PRAGMA integrity_check').get() as any)?.integrity_check === 'ok';
      b.close();
      if (ok && countLogs(p) >= need) return f;
    } catch { /* unreadable: try the next one */ }
  }
  return null;
}
for (const name of fs.readdirSync(DATA)) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(path.join(DATA, name))) continue; // already removed with its main file
  if (/^pace_it\.sqlite\.before-/.test(name) || /^pace_it\.sqlite\.(bak|old|orig)$/.test(name)) {
    const good = healthyBackupCovering(p);
    if (good) { for (const x of [p, `${p}-wal`, `${p}-shm`]) fs.rmSync(x, { force: true }); say(`Removed old copy ${name} (verified backup ${good} holds at least as many connections).`); }
    else say(`KEPT ${name}: no healthy backup with at least as many connections was found. Run "npm run backup <folder>" first, then run this again.`);
  } else if (/\.tmp(-wal|-shm)?$/.test(name) && fs.statSync(p).isFile()) {
    fs.rmSync(p, { force: true }); say(`Removed unfinished temporary file ${name}.`);
  }
}

// 2. new secret key, everyone signed out -------------------------------------------------------------------
fs.writeFileSync(KEY, crypto.randomBytes(32).toString('hex'), { encoding: 'utf-8', mode: 0o600 });
try { fs.rmSync(path.join(BACKUPS, 'extras', 'pace_it_secret.key'), { force: true }); } catch { /* none */ } // the old key copy is stale; the next backup stores the new one
try { db.exec('DELETE FROM sessions'); } catch { /* no sessions table yet */ }
say('Created a new secret key and signed every user out. (Everyone just logs in again; no data is touched.)');

// 3. permissions ------------------------------------------------------------------------------------------------
try {
  if (process.platform === 'win32') {
    const who = process.env.USERNAME || '';
    if (who) {
      execFileSync('icacls', [DATA, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F'], { stdio: 'ignore' });
      say(`Restricted the data folder to ${who}, SYSTEM and Administrators.`);
    }
  } else {
    fs.chmodSync(DATA, 0o700);
    for (const f of [KEY, DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    say('Restricted the data folder to your account.');
  }
} catch (e: any) { say('Could not change folder permissions automatically: ' + (e?.message || e)); }

// 4. default passwords -------------------------------------------------------------------------------------------
function matches(pw: string, stored: string): boolean {
  const [, n, saltHex, hashHex] = String(stored).split('$');
  try {
    const exp = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), exp.length, { N: Number(n), maxmem: 128 * 1024 * 1024 });
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  } catch { return false; }
}
const WEAK = ['admin', 'admin1234', 'admin12345', 'password', '12345678', 'password123', 'paceit', 'paceit123'];
const users = db.prepare('SELECT username, password FROM users').all() as { username: string; password: string }[];
let weak = 0;
for (const u of users) {
  const hit = WEAK.find((w) => matches(w, u.password));
  if (hit) { weak++; say(`WARNING: account "${u.username}" uses an easily guessed password. Reset it:  npm run reset-password -- ${u.username}`); }
}
db.close();
say(`\nDone. ${users.length} account(s) checked, ${weak} weak.`);
say('If a copy of this folder (or a zip of it) was ever shared, also run:  npm run reset-password -- --all');
