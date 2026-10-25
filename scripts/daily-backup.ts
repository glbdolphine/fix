// The daily backup, run as its OWN process by the website (server/db.ts) so that copying and checking data never
// blocks the site. You can also run it by hand:  npm run backup:daily
//
// What it does, in order (each step is independent, a failure in one is reported and the others still run):
//   1. data/backups/pace_it-YYYY-MM-DD.sqlite   consistent snapshot of the database (verified before it gets its name)
//   2. second drive (only when PACE_BACKUP_DIR is set): the same snapshot + new attached forms + secret key + institute list
//   3. health check of the live database (own connection) and clean-up of unused attached-form files
// Results go to data/backups/daily-state.json and data/backups/backup-status.json.
import fs from 'fs';
import path from 'path';
import { backupSnapshot, gcLiveBlobs, healthCheck, sameDisk } from '../server/backupCore';

const DATA = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const LIVE = path.join(DATA, 'pace_it.sqlite');
const LOCAL = path.join(DATA, 'backups');
const MIRROR = (process.env.PACE_BACKUP_DIR || '').trim();
const KEEP_DAILY = Number(process.env.PACE_BACKUP_KEEP_DAILY || 30);
const KEEP_WEEKS = Number(process.env.PACE_BACKUP_KEEP_WEEKS || 26);
const MIRROR_FOLDER = 'PaceIT-Backups';

const two = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
const log = (m: string) => console.log(`[Pace IT backup] ${m}`);
const writeJson = (f: string, o: unknown) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch { /* best effort */ } };

if (!fs.existsSync(LIVE)) { console.error(`[Pace IT backup] No database at ${LIVE}.`); process.exit(1); }
fs.mkdirSync(LOCAL, { recursive: true });

// one helper at a time
const lock = path.join(LOCAL, '.daily.lock');
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } }
try {
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
} catch {
  let other = 0;
  try { other = Number(fs.readFileSync(lock, 'utf-8')); } catch { /* gone */ }
  if (other && pidAlive(other) && other !== process.pid) { log('Another backup is already running.'); process.exit(0); }
  fs.writeFileSync(lock, String(process.pid));
}
process.on('exit', () => { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } });

const stateFile = path.join(LOCAL, 'daily-state.json');
let prev: any = {};
try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* none */ }
const state: any = { day, ok: prev.day === day ? prev.ok === true : false, mirrorConfigured: Boolean(MIRROR), mirrorOk: prev.day === day ? prev.mirrorOk : undefined, attemptedAt: new Date().toISOString() };
writeJson(stateFile, state);

const status: any = { at: new Date().toISOString(), day, local: null, mirror: null, health: null, warnings: [] as string[] };
const warnFile = path.join(LOCAL, '!BACKUP-WARNING.txt');
const warnings: string[] = status.warnings;

async function main() {
  // 1. local snapshot --------------------------------------------------------------------------------------------
  const localFile = path.join(LOCAL, `pace_it-${day}.sqlite`);
  try {
    const r = await backupSnapshot({
      dataDir: DATA, liveFile: LIVE, dbDir: LOCAL, fileName: path.basename(localFile), blobsDir: null,
      extrasDir: path.join(LOCAL, 'extras'), keepDaily: KEEP_DAILY, keepWeeks: KEEP_WEEKS, log,
    });
    state.ok = true;
    status.local = { file: path.basename(localFile), created: r.created, logs: r.logs, forms: r.forms, pruned: r.pruned };
    warnings.push(...r.warnings);
    if (r.created) log(`Daily backup done: ${path.basename(localFile)} (${r.logs} connections, ${r.forms} attached forms, integrity ok).`);
  } catch (e: any) {
    state.ok = false;
    warnings.push(`Local backup FAILED: ${e?.message || e}`);
    console.error('[Pace IT backup] Local backup failed:', e);
  }

  // 2. second drive ----------------------------------------------------------------------------------------------
  if (MIRROR) {
    try {
      const root = path.join(MIRROR, MIRROR_FOLDER);
      const rel = path.relative(DATA, root);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('PACE_BACKUP_DIR must be outside the data folder');
      if (!fs.existsSync(MIRROR)) throw new Error(`the backup drive/folder ${MIRROR} was not found (is the drive plugged in?)`);
      fs.mkdirSync(root, { recursive: true });
      const probe = path.join(root, '.write-test');
      fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true });
      if (sameDisk(DATA, root)) warnings.push(`PACE_BACKUP_DIR (${MIRROR}) is on the SAME disk as the data. If that disk fails, the data and this backup are both lost. Use a second physical drive.`);
      const d = new Date();
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      // one drive copy per day (the newest drive copy of today is enough)
      const todays = fs.existsSync(path.join(root, 'db')) ? fs.readdirSync(path.join(root, 'db')).filter((f) => f.startsWith(`pace_it-${day.replace(/-/g, '')}-`) && f.endsWith('.sqlite')) : [];
      if (todays.length) {
        state.mirrorOk = true;
        status.mirror = { file: todays.sort().pop(), created: false };
      } else {
        const r = await backupSnapshot({
          dataDir: DATA, liveFile: LIVE, dbDir: path.join(root, 'db'), fileName: `pace_it-${stamp}.sqlite`, blobsDir: path.join(root, 'blobs'),
          extrasDir: path.join(root, 'extras'), keepDaily: KEEP_DAILY, keepWeeks: KEEP_WEEKS, scrub: 25, log,
        });
        state.mirrorOk = true;
        status.mirror = { file: path.basename(r.file), created: r.created, formsCopied: r.blobsCopied, mbCopied: Math.round(r.blobBytes / 1048576), pruned: r.pruned };
        warnings.push(...r.warnings);
        try { fs.appendFileSync(path.join(root, 'backup-log.txt'), `${new Date().toISOString()}  OK  ${path.basename(r.file)}  ${r.logs} connections  ${r.forms} forms (+${r.blobsCopied} new)\n`); } catch { /* optional */ }
        log(`Second-drive copy done: ${path.basename(r.file)} (+${r.blobsCopied} new attached forms).`);
      }
    } catch (e: any) {
      state.mirrorOk = false;
      warnings.push(`Second-drive backup FAILED: ${e?.message || e}`);
      console.error('[Pace IT backup] Second-drive backup failed:', e);
    }
  } else {
    warnings.push('PACE_BACKUP_DIR is not set: the backups exist only on the same disk as the data. Set it to a second physical drive (see README, "Backups").');
  }

  // 3. health + clean-up -----------------------------------------------------------------------------------------
  const problemFile = path.join(LOCAL, '!DATABASE-PROBLEM.txt');
  try {
    const h = healthCheck(DATA, LIVE);
    status.health = h;
    if (!h.ok) {
      fs.writeFileSync(problemFile, `${new Date().toISOString()}\n${h.problems.join('\n')}\nOld backups were NOT deleted. Stop the server and run "npm run restore" if the database is damaged.\n`);
      console.error(`[Pace IT backup] WARNING: the live database has problems: ${h.problems.join('; ')}`);
    } else {
      fs.rmSync(problemFile, { force: true });
    }
    for (const n of h.notes) log(`Note: ${n}`);
    if (h.ok) {
      const removed = gcLiveBlobs(DATA, LIVE, LOCAL, 30, log);
      if (removed) log(`Removed ${removed} unused attached-form file(s) (no longer used and older than 30 days).`);
    }
  } catch (e: any) {
    warnings.push(`Health check could not run: ${e?.message || e}`);
  }

  writeJson(path.join(LOCAL, 'backup-status.json'), status);
  if (warnings.length) fs.writeFileSync(warnFile, `${new Date().toISOString()}\n${warnings.join('\n')}\n`);
  else fs.rmSync(warnFile, { force: true });
  for (const w of warnings) console.warn(`[Pace IT backup] WARNING: ${w}`);
  state.attemptedAt = new Date().toISOString();
  writeJson(stateFile, state);
  process.exit(state.ok ? 0 : 1);
}

main().catch((e) => { console.error('[Pace IT backup] Failed:', e); state.attemptedAt = new Date().toISOString(); writeJson(stateFile, state); process.exit(1); });
