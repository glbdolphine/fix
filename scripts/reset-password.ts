// Sets a new random password for one account (or every account) and signs it out everywhere.
//   STOP THE SERVER FIRST.      npm run reset-password -- admin        npm run reset-password -- --all
// The new password is printed once. Ask each person to change it after signing in.
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const DB = path.join(path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data')), 'pace_it.sqlite');
const arg = process.argv[2];
if (!arg) { console.error('Usage: npm run reset-password -- <username>   or   npm run reset-password -- --all'); process.exit(2); }

const db = new DatabaseSync(DB);
try { db.exec('PRAGMA busy_timeout = 1500'); db.exec('BEGIN IMMEDIATE'); }
catch { console.error('The database is in use. Stop the Pace IT server first.'); process.exit(1); }

const N = 32768;
function hash(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${N}$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64, { N, maxmem: 128 * 1024 * 1024 }).toString('hex')}`;
}
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const random = () => Array.from(crypto.randomBytes(16), (b) => ALPHA[b % ALPHA.length]).join('');

const rows = (arg === '--all'
  ? db.prepare('SELECT id, username FROM users').all()
  : db.prepare('SELECT id, username FROM users WHERE lower(username) = ?').all(arg.toLowerCase().replace(/\s+/g, '_'))) as { id: string; username: string }[];
if (!rows.length) { db.exec('ROLLBACK'); console.error('No such account.'); process.exit(1); }

for (const r of rows) {
  const pw = random();
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash(pw), r.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.id);
  try {
    db.prepare('INSERT INTO security_events (id, at, type, username, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), new Date().toISOString(), 'password_reset', r.username, 'local', 'reset from the command line; signed out everywhere');
  } catch { /* log table missing */ }
  console.log(`${r.username.padEnd(20)} new password: ${pw}`);
}
db.exec('COMMIT');
db.close();
console.log('\nDone. Write these down now; they are not shown again.');
