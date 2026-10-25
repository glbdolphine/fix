import fs from 'fs';
import path from 'path';

// A tiny lock file (data/.maintenance) is how the separate `npm run backup` process tells the running website
// "stop accepting changes for a moment". The website checks it on every change request and tells every open
// browser through the live-update stream.
//
// The lock is ignored (treated as stale) when the process that made it is gone. A lock that is NOT a restore is
// also ignored once it is older than MAX_AGE_MS, so a hung helper can never leave the website blocked forever.
// Backups no longer use this lock at all (they copy a consistent snapshot while the site keeps working);
// only `npm run restore` does, and a restore lock lasts as long as the restore process is alive.

export const MAINTENANCE_MAX_AGE_MS = 45 * 60 * 1000;

export interface MaintenanceInfo {
  pid: number;
  since: number;
  reason: string;
}

export function maintenanceFile(dataDir: string): string {
  return path.join(dataDir, '.maintenance');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists but belongs to someone else
  }
}

/** The active lock, or null when there is none (a stale lock counts as none). */
export function readMaintenance(dataDir: string): MaintenanceInfo | null {
  const file = maintenanceFile(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw);
    const info: MaintenanceInfo = { pid: Number(j.pid), since: Number(j.since), reason: String(j.reason || 'backup') };
    if (!Number.isFinite(info.since)) return null;
    if (info.reason !== 'restore' && Date.now() - info.since > MAINTENANCE_MAX_AGE_MS) return null;
    if (!pidAlive(info.pid)) return null;
    return info;
  } catch {
    return null; // unreadable (e.g. half-written): not a valid lock
  }
}

/** Takes the lock. Returns false when another live process already holds it. */
export function acquireMaintenance(dataDir: string, reason: string): boolean {
  if (readMaintenance(dataDir)) return false;
  const file = maintenanceFile(dataDir);
  try {
    fs.rmSync(file, { force: true }); // remove a stale one
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since: Date.now(), reason }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/** Releases the lock, but only if this process owns it. */
export function releaseMaintenance(dataDir: string): void {
  const file = maintenanceFile(dataDir);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Number(j.pid) === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}
