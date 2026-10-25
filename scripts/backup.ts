// npm run backup
//
// Asks which drive to back up to (e.g. D or F, an external or internal drive), finds that drive and writes a verified
// copy there: the database snapshot, every attached form it needs (forms are files named by their hash, so only the
// ones the drive does not have yet are copied), the secret key and the institute list.
// The website keeps working the whole time (no maintenance mode): the database is copied as one consistent snapshot.
//
//   npm run backup                    asks for the drive
//   npm run backup -- d               no questions (also accepts  D:  D:\  a volume name, or a folder path)
//   npm run backup -- d --keep 14     keep the newest 14 daily copies on that drive (default 14), plus one per week for 12 weeks (--weeks)
//   npm run backup -- d --force       skip the "much smaller than the last backup" warning
//
// Restore with:  npm run restore   (see README)
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { execFileSync } from 'child_process';
import { backupSnapshot, sameDisk } from '../server/backupCore';

const DATA = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const LIVE_DB = path.join(DATA, 'pace_it.sqlite');
const IS_WIN = process.platform === 'win32';
const FOLDER_NAME = 'PaceIT-Backups';

// ---- arguments -------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
let keep = Number(process.env.PACE_BACKUP_KEEP || 14);
let weeks = 12;
let driveArg = process.env.PACE_BACKUP_DIR || '';
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep') keep = Number(args[++i]);
  else if (args[i] === '--weeks') weeks = Number(args[++i]);
  else if (args[i] === '--force') force = true;
  else if (!args[i].startsWith('--')) driveArg = args[i];
}
if (!Number.isInteger(keep) || keep < 1) {
  console.error('--keep must be a whole number of 1 or more.');
  process.exit(2);
}

let lockFile = '';
function cleanup() {
  if (lockFile) { try { fs.rmSync(lockFile, { force: true }); } catch { /* gone */ } lockFile = ''; }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => { console.error(`\nStopped (${sig}).`); process.exit(130); });

function die(msg: string): never {
  console.error('\nBACKUP FAILED: ' + msg);
  console.error('Nothing in your live data was changed (and the website was never closed).');
  cleanup();
  process.exit(1);
}

// ---- drive discovery ---------------------------------------------------------------------------------------------
interface Drive { id: string; root: string; label: string; kind: string; free: number; total: number }

const KIND: Record<number, string> = { 0: 'unknown', 1: 'no root', 2: 'removable/USB', 3: 'internal disk', 4: 'network', 5: 'CD/DVD', 6: 'RAM disk' };

function space(root: string): { free: number; total: number } {
  try {
    const s = fs.statfsSync(root);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { free: 0, total: 0 };
  }
}

function discoverDrives(): Drive[] {
  const found: Drive[] = [];
  if (IS_WIN) {
    // Labels and drive types come from Windows itself; if that is unavailable, plain letters are scanned instead.
    const info = new Map<string, { label: string; kind: string }>();
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType | ConvertTo-Json -Compress'], { timeout: 8000, windowsHide: true, encoding: 'utf-8' });
      const parsed = JSON.parse(out);
      for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
        if (d?.DeviceID) info.set(String(d.DeviceID).toUpperCase(), { label: String(d.VolumeName || ''), kind: KIND[Number(d.DriveType)] || 'unknown' });
      }
    } catch { /* fall back to scanning */ }
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c);
      const root = `${L}:\\`;
      let ok = false;
      try { ok = fs.existsSync(root); } catch { ok = false; }
      if (!ok) continue;
      const meta = info.get(`${L}:`);
      found.push({ id: L, root, label: meta?.label || '', kind: meta?.kind || '', ...space(root) });
    }
  } else {
    const bases = ['/Volumes', '/mnt', '/media', '/run/media'];
    const roots: string[] = [];
    for (const b of bases) {
      let names: string[] = [];
      try { names = fs.readdirSync(b); } catch { continue; }
      for (const n of names) {
        const p = path.join(b, n);
        try {
          if (!fs.statSync(p).isDirectory()) continue;
          // /media/<user>/<drive>
          if ((b === '/media' || b === '/run/media') && fs.readdirSync(p).length >= 0) {
            const inner = fs.readdirSync(p).map((x) => path.join(p, x)).filter((x) => { try { return fs.statSync(x).isDirectory(); } catch { return false; } });
            if (inner.length) { roots.push(...inner); continue; }
          }
          roots.push(p);
        } catch { /* unreadable */ }
      }
    }
    for (const r of roots) found.push({ id: path.basename(r), root: r, label: path.basename(r), kind: '', ...space(r) });
  }
  return found;
}

const gb = (n: number) => (n / 1073741824).toFixed(1) + ' GB';
function describe(d: Drive): string {
  const extra = [d.label && `"${d.label}"`, d.kind, d.total ? `${gb(d.free)} free of ${gb(d.total)}` : ''].filter(Boolean).join(', ');
  return IS_WIN ? `  ${d.id}:  ${extra}` : `  ${d.root}  ${extra}`;
}

function resolveDrive(input: string, drives: Drive[]): Drive | null {
  const raw = input.trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  if (IS_WIN) {
    const m = raw.match(/^([A-Za-z])(?::[\\/]*)?$/);
    if (m) return drives.find((d) => d.id === m[1].toUpperCase()) || null;
  }
  const byName = drives.find((d) => d.label.toLowerCase() === raw.toLowerCase() || d.id.toLowerCase() === raw.toLowerCase());
  if (byName) return byName;
  // a folder path (a scheduled task or a network share can pass one)
  try {
    const abs = path.resolve(raw);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const root = path.parse(abs).root;
      return { id: abs, root: abs, label: '', kind: 'folder', ...space(abs || root) };
    }
  } catch { /* not a path */ }
  return null;
}

async function chooseDrive(): Promise<Drive> {
  console.log('Looking for drives ...');
  const drives = discoverDrives();
  if (driveArg) {
    const d = resolveDrive(driveArg, drives);
    if (!d) {
      console.error(`\nDrive "${driveArg}" was not found.`);
      if (drives.length) { console.error('Drives found on this computer:'); drives.forEach((x) => console.error(describe(x))); }
      die('Check that the drive is plugged in and switched on, then run the command again.');
    }
    return d;
  }
  if (!process.stdin.isTTY) die('No drive given. Run  npm run backup -- D   (or run it in a normal terminal window to be asked).');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const list = attempt === 0 ? drives : discoverDrives();
      console.log('\nDrives found on this computer:');
      if (list.length) list.forEach((x) => console.log(describe(x))); else console.log('  (none found)');
      const answer = (await rl.question(`\nBack up to which drive? ${IS_WIN ? '(for example D or F)' : '(name or folder)'}  [Enter to cancel]: `)).trim();
      if (!answer) { console.log('Cancelled. Nothing was changed.'); process.exit(0); }
      const d = resolveDrive(answer, list);
      if (d) return d;
      console.log(`\nCould not find a drive called "${answer}". Is it plugged in? Try again.`);
    }
  } finally {
    rl.close();
  }
  return die('No valid drive was chosen.');
}

// ---- main -------------------------------------------------------------------------------------------------------
const two = (n: number) => String(n).padStart(2, '0');

async function main() {
  if (!fs.existsSync(LIVE_DB)) die(`No database at ${LIVE_DB}. Run this from the project folder (the one containing "data").`);

  const drive = await chooseDrive();
  const dest = drive.kind === 'folder' ? path.join(drive.root, 'db') : path.join(drive.root, FOLDER_NAME, 'db');
  const destRoot = path.dirname(dest);

  // never inside the live data folder
  const rel = path.relative(DATA, destRoot);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) die('The backup must go outside the data folder. Choose another drive.');
  if (sameDisk(DATA, destRoot)) {
    console.log(`\nNOTE: ${drive.id} is the same disk as the live data. If this disk dies, the data AND this backup are lost.\n      An external or second physical drive is much safer.`);
  }

  try { fs.mkdirSync(dest, { recursive: true }); } catch (e: any) { die(`Cannot write to the drive (${e?.code || e?.message}). Is it read-only or full?`); }
  // prove the drive really is writable before starting
  const probe = path.join(dest, '.write-test');
  try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true }); } catch (e: any) { die(`The drive is not writable (${e?.code || e?.message}).`); }

  // one backup at a time (to this drive)
  lockFile = path.join(destRoot, '.backup.lock');
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { /* gone */ }
    // a big first copy can take many hours: only treat the lock as stale when its process is gone
    let other = 0;
    try { other = Number(fs.readFileSync(lockFile, 'utf-8')); } catch { /* gone */ }
    let alive = false;
    try { if (other) { process.kill(other, 0); alive = true; } } catch (e: any) { alive = e?.code === 'EPERM'; }
    if (alive && age < 7 * 24 * 3600 * 1000) { const l = lockFile; lockFile = ''; die(`Another backup seems to be running (${l}). If not, delete that file and try again.`); }
    fs.writeFileSync(lockFile, String(process.pid));
  }

  const d = new Date();
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  console.log(`\nTarget: ${drive.root}  ->  ${destRoot}`);
  console.log('The website stays open while this runs.\n');

  let r;
  try {
    r = await backupSnapshot({
      dataDir: DATA, liveFile: LIVE_DB, dbDir: dest, fileName: `pace_it-${stamp}.sqlite`, blobsDir: path.join(destRoot, 'blobs'),
      extrasDir: path.join(destRoot, 'extras'), keepDaily: keep, keepWeeks: weeks, force, scrub: 100,
      log: (m) => console.log('  ' + m),
    });
  } catch (e: any) {
    return die(String(e?.message || e));
  }

  const mb = (fs.statSync(r.file).size / 1048576).toFixed(1);
  const line = `${new Date().toISOString()}  OK  ${path.basename(r.file)}  ${mb} MB  ${r.logs} connections  ${r.forms} forms (+${r.blobsCopied} new)`;
  try { fs.appendFileSync(path.join(destRoot, 'backup-log.txt'), line + '\n'); } catch { /* log is optional */ }

  cleanup();
  for (const w of r.warnings) console.log(`\nWARNING: ${w}`);
  console.log(`\nBackup file : ${r.file}  (${mb} MB)`);
  console.log(`Contents    : ${r.logs} connections, ${r.forms} attached forms (${r.blobsCopied} new copied, ${(r.blobBytes / 1048576).toFixed(1)} MB), integrity ok`);
  console.log(`Old copies  : ${r.pruned ? r.pruned + ' removed' : 'none removed'}${r.scrubbed ? `; ${r.scrubbed} older form copies re-checked` : ''}`);
  console.log('\nBACKUP OK');
}

main().catch((e) => die(String(e?.stack || e)));
