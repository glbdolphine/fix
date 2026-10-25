// npm run restore
//
// Puts a backup back as the live database. It checks the backup first, refuses to run while the website is running,
// keeps the current database (moved aside, not deleted), brings back every attached form the backup needs, and checks
// the result. A restore that takes hours is fine: it prints progress and can be re-run.
//
//   npm run restore                          lists the backups it can find and asks which one
//   npm run restore -- <file or folder>      a snapshot file (pace_it-*.sqlite), or a backup folder (the newest snapshot is used)
//   npm run restore -- <path> --yes          do not ask for confirmation
//   npm run restore -- <path> --deep         re-hash every attached form before restoring (slow, thorough)
//   npm run restore -- <path> --allow-missing  restore even if some attached forms are not in the backup
//   npm run restore -- <path> --dry-run      only check the backup, change nothing
//
// STOP THE WEBSITE FIRST.
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { acquireMaintenance, releaseMaintenance } from '../server/maintenance';
import { blobPath, blobRoot, hashFile, isSha } from '../server/blobs';
import { EXTRA_FILES, SECRET_KEY_NAME, parseStamp, verifySnapshot, freeBytes } from '../server/backupCore';
import { LATEST_VERSION } from '../server/migrations';

const DATA = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const LIVE = path.join(DATA, 'pace_it.sqlite');
const LOCAL = path.join(DATA, 'backups');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const target = args.find((a) => !a.startsWith('--')) || '';
const yes = flag('--yes'), deep = flag('--deep'), allowMissing = flag('--allow-missing'), dryRun = flag('--dry-run');

const say = (m = '') => console.log(m);
let locked = false;
function cleanup() { if (locked) { releaseMaintenance(DATA); locked = false; } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => { console.error(`\nStopped (${sig}).`); process.exit(130); });
function die(msg: string): never {
  console.error('\nRESTORE STOPPED: ' + msg);
  console.error('Your current database was not replaced.');
  cleanup();
  process.exit(1);
}

interface Candidate { file: string; where: string; when: Date | null }

function snapshotsIn(dir: string, where: string): Candidate[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^pace_it-.*\.sqlite$/.test(n))
    .map((n) => ({ file: path.join(dir, n), where, when: parseStamp(n) ?? fs.statSync(path.join(dir, n)).mtime }))
    .sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0));
}

function findCandidates(): Candidate[] {
  const out: Candidate[] = [...snapshotsIn(LOCAL, 'this computer (data/backups)')];
  const mirror = (process.env.PACE_BACKUP_DIR || '').trim();
  if (mirror) {
    for (const r of [path.join(mirror, 'PaceIT-Backups', 'db'), path.join(mirror, 'db')]) out.push(...snapshotsIn(r, `second drive (${r})`));
  }
  return out;
}

function resolveTarget(t: string): string {
  const abs = path.resolve(t);
  if (!fs.existsSync(abs)) die(`${abs} does not exist.`);
  if (fs.statSync(abs).isFile()) return abs;
  for (const dir of [abs, path.join(abs, 'db'), path.join(abs, 'PaceIT-Backups', 'db')]) {
    const list = snapshotsIn(dir, dir);
    if (list.length) return list[0].file;
  }
  return die(`No pace_it-*.sqlite snapshot found in ${abs}.`);
}

/** Where the attached forms of a snapshot are kept: <backup root>/blobs next to its db folder, if there is one. */
function backupRootOf(snapshot: string): string {
  const dir = path.dirname(snapshot);
  return path.basename(dir) === 'db' ? path.dirname(dir) : dir;
}

async function chooseSnapshot(): Promise<string> {
  if (target) return resolveTarget(target);
  const list = findCandidates();
  if (!list.length) die('No backups found. Pass the path of a snapshot file or backup folder:  npm run restore -- <path>');
  if (!process.stdin.isTTY) die('Several backups exist. Pass one:  npm run restore -- <path>');
  say('\nBackups found:');
  list.slice(0, 40).forEach((c, i) => say(`  ${String(i + 1).padStart(2)}.  ${path.basename(c.file)}   ${c.when ? c.when.toLocaleString() : ''}   [${c.where}]`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question('\nRestore which one? (number, Enter to cancel): ')).trim();
    if (!a) { say('Cancelled. Nothing was changed.'); process.exit(0); }
    const n = Number(a);
    if (!Number.isInteger(n) || n < 1 || n > Math.min(40, list.length)) die('That is not one of the numbers in the list.');
    return list[n - 1].file;
  } finally {
    rl.close();
  }
}

/** The website must not be running: a running server has the file open and would overwrite the restore. */
function assertServerStopped() {
  if (!fs.existsSync(LIVE)) return;
  let d: DatabaseSync | null = null;
  try {
    d = new DatabaseSync(LIVE);
    d.exec('PRAGMA busy_timeout = 1500');
    // Leaving WAL mode needs exclusive access, which a running server prevents.
    const row = d.prepare('PRAGMA journal_mode = DELETE').get() as Record<string, unknown>;
    if (String(Object.values(row)[0]).toLowerCase() === 'wal') throw Object.assign(new Error('database is locked'), { code: 'BUSY' });
  } catch (e: any) {
    if (/locked|busy/i.test(String(e?.message || e)) || e?.code === 'BUSY') die('The website is still running (the database is in use). Stop it first, then run this again.');
    say(`NOTE: the current database could not be opened (${e?.message || e}). It will be moved aside and replaced.`);
  } finally {
    try { d?.close(); } catch { /* closed */ }
  }
}

async function main() {
  const snapshot = await chooseSnapshot();
  say(`\nBackup to restore : ${snapshot}`);

  // 1. check the backup ---------------------------------------------------------------------------------------
  say('\n1/6 Checking the backup ...');
  let info;
  try { info = verifySnapshot(snapshot); } catch (e: any) { return die(`this backup is not good: ${e?.message || e}`); }
  if (info.userVersion > LATEST_VERSION) die(`this backup is from a newer version of the app (schema ${info.userVersion}, this app understands up to ${LATEST_VERSION}).`);
  say(`    integrity ok, ${info.logs} connections, ${info.users} accounts, ${info.forms} attached forms, schema ${info.userVersion}${info.userVersion < LATEST_VERSION ? ' (the app upgrades it on start)' : ''}`);

  // 2. attached forms -------------------------------------------------------------------------------------------
  say('\n2/6 Checking the attached forms ...');
  const root = backupRootOf(snapshot);
  const backupBlobs = path.join(root, 'blobs');
  const liveBlobs = blobRoot(DATA);
  const toCopy: { sha: string; from: string }[] = [];
  const missing: string[] = [];
  let have = 0;
  let n = 0;
  for (const sha of info.refs) {
    if (!isSha(sha)) continue;
    const inBackup = blobPath(backupBlobs, sha);
    const inLive = blobPath(liveBlobs, sha);
    const src = fs.existsSync(inLive) ? inLive : fs.existsSync(inBackup) ? inBackup : '';
    if (!src) { missing.push(sha); continue; }
    if (deep) {
      if ((await hashFile(src)) !== sha) { missing.push(sha); continue; }
      if (++n % 100 === 0) say(`    ${n} / ${info.refs.length} checked ...`);
    }
    if (src === inLive) have++; else toCopy.push({ sha, from: src });
  }
  say(`    ${info.refs.length} forms referenced: ${have} already on this computer, ${toCopy.length} to copy from the backup, ${missing.length} missing`);
  if (missing.length && !allowMissing) {
    die(`${missing.length} attached form file(s) are not in the backup (first: ${missing[0].slice(0, 16)}...). Use the newest complete backup, or add --allow-missing to restore the rest.`);
  }
  if (info.legacyInline) say(`    ${info.legacyInline} attached form(s) are stored inside this older-format backup; the app moves them to files when it starts.`);

  if (dryRun) { say('\nDry run: the backup looks good. Nothing was changed.'); return; }

  // 3. website stopped? -------------------------------------------------------------------------------------------
  say('\n3/6 Checking that the website is stopped ...');
  assertServerStopped();
  const need = fs.statSync(snapshot).size * 1.2 + toCopy.reduce((s, c) => s + (fs.existsSync(c.from) ? fs.statSync(c.from).size : 0), 0);
  if (freeBytes(DATA) < need + 50 * 1048576) die('Not enough free space on the data disk for the restore.');

  if (!yes) {
    if (!process.stdin.isTTY) die('Run it in a normal terminal window, or add --yes.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`\nThis REPLACES the current database with ${path.basename(snapshot)} (${info.logs} connections).\nThe current database is kept in data/backups/before-restore-*. Type RESTORE to continue: `)).trim();
    rl.close();
    if (a !== 'RESTORE') { say('Cancelled. Nothing was changed.'); return; }
  }

  if (!acquireMaintenance(DATA, 'restore')) die('Could not take the maintenance lock (is another restore running?).');
  locked = true;

  // 4. attached forms back ----------------------------------------------------------------------------------------
  say('\n4/6 Bringing back attached forms ...');
  let done = 0;
  for (const c of toCopy) {
    const dest = blobPath(liveBlobs, c.sha);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await fs.promises.copyFile(c.from, tmp);
      if ((await hashFile(tmp)) !== c.sha) throw new Error('copy does not match its hash');
      fs.renameSync(tmp, dest);
    } catch (e: any) {
      fs.rmSync(tmp, { force: true });
      die(`could not copy an attached form (${e?.message || e}). The forms copied so far are harmless; run the restore again.`);
    }
    if (++done % 100 === 0 || done === toCopy.length) say(`    ${done} / ${toCopy.length}`);
  }

  // 5. swap the database ------------------------------------------------------------------------------------------
  say('\n5/6 Replacing the database ...');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = path.join(LOCAL, `before-restore-${stamp}`);
  fs.mkdirSync(aside, { recursive: true });
  const moved: [string, string][] = [];
  for (const ext of ['', '-wal', '-shm']) {
    const f = LIVE + ext;
    if (!fs.existsSync(f)) continue;
    const to = path.join(aside, path.basename(f));
    fs.renameSync(f, to);
    moved.push([f, to]);
  }
  const undo = () => { for (const [from, to] of moved) { try { fs.rmSync(from, { force: true }); fs.renameSync(to, from); } catch { /* best effort */ } } };
  const staging = `${LIVE}.restoring`;
  try {
    fs.rmSync(staging, { force: true });
    fs.copyFileSync(snapshot, staging);
    const v = verifySnapshot(staging);
    if (v.logs !== info.logs || v.users !== info.users) throw new Error('the copied database does not match the backup');
    fs.renameSync(staging, LIVE);
    for (const ext of ['-wal', '-shm']) fs.rmSync(LIVE + ext, { force: true });
  } catch (e: any) {
    fs.rmSync(staging, { force: true });
    undo();
    die(`could not put the backup in place (${e?.message || e}). The previous database was put back.`);
  }
  // keep a copy of the old key and extras too; restore the key only when this computer has none
  const extras = path.join(root, 'extras');
  for (const name of EXTRA_FILES) {
    const src = path.join(extras, name);
    const dest = path.join(DATA, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) continue; // never overwrite what is here
    try { fs.copyFileSync(src, dest); if (name === SECRET_KEY_NAME) { try { fs.chmodSync(dest, 0o600); } catch { /* not supported */ } } say(`    also restored ${name}`); }
    catch (e: any) { say(`    could not restore ${name}: ${e?.message || e}`); }
  }

  // 6. final check -----------------------------------------------------------------------------------------------
  say('\n6/6 Checking the restored database ...');
  let final;
  try { final = verifySnapshot(LIVE); } catch (e: any) { undo(); return die(`the restored database failed its check (${e?.message || e}). The previous database was put back.`); }
  let missingNow = 0;
  for (const sha of final.refs) if (!fs.existsSync(blobPath(liveBlobs, sha))) missingNow++;
  cleanup();
  say(`\n    ${final.logs} connections, ${final.users} accounts, ${final.forms} attached forms, integrity ok${missingNow ? `, ${missingNow} form file(s) missing` : ''}`);
  say(`    The previous database is in ${aside}`);
  if (!fs.existsSync(path.join(DATA, SECRET_KEY_NAME))) say('    NOTE: there is no secret key. The website creates a new one and everyone has to sign in again.');
  say('\nRESTORE OK. Start the website now.');
}

main().catch((e) => die(String(e?.stack || e)));
