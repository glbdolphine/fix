import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let tsxAvailable = true;
try { require.resolve('tsx'); } catch { tsxAvailable = false; }

const childSource = String.raw`
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
let db;
try {
  ({ db } = await import(pathToFileURL(path.resolve('server/db.ts')).href));
  await db.ready();
  const user = { id: 'test-user', username: 'test_user', displayName: 'Test Operator', role: 'user', disabled: false, createdAt: new Date().toISOString() };
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(), logNo: 1, date: '25 Oct 2026', foremanName: 'Test Foreman', requestType: 'New User ID',
    customerName: 'Atomic Baseline School', nmsId: 'NMS-TEST-1', issueFound: '', missingWrongDetails: '', actionTaken: '',
    reasonForAction: '', foremanInformed: '', followUpNeeded: '', status: 'In Progress', supervisorInformed: '', remarks: '',
    mac: '', createdAt: now, updatedAt: now,
  };
  const created = db.saveLog(entry, user);
  assert.equal(db.getLogs().some((x) => x.id === created.id), true, 'saved row is persisted');

  assert.throws(() => db.saveLog({ ...created, customerName: 'Should Roll Back', upacFormName: 'unsafe.pdf', upacFormData: '%%%not-base64' }, user, created.id));
  assert.equal(db.getLogs().find((x) => x.id === created.id)?.customerName, 'Atomic Baseline School', 'failed attachment write rolls back core log update');

  const malformed = structuredClone(db.exportFull());
  malformed.tables.logs.columns = [];
  malformed.tables.logs.rows = [];
  malformed.counts.logs = 0;
  await assert.rejects(db.restoreFull(malformed, user), /invalid columns/);
  assert.equal(db.getLogs().find((x) => x.id === created.id)?.customerName, 'Atomic Baseline School', 'malformed restore leaves live row untouched');

  const interrupted = structuredClone(db.exportFull());
  interrupted.tables.settings.rows.push([...interrupted.tables.settings.rows[0]]);
  interrupted.counts.settings = interrupted.tables.settings.rows.length;
  await assert.rejects(db.restoreFull(interrupted, user), /constraint failed|UNIQUE/i);
  assert.equal(db.getLogs().find((x) => x.id === created.id)?.customerName, 'Atomic Baseline School', 'mid-restore SQL failure rolls every table back');

  db.saveLog({ ...entry, id: crypto.randomUUID(), logNo: 2, customerName: 'Second Row' }, user);
  const restore = await db.restoreFull(db.exportFull(), user);
  assert.equal(restore.counts.logs, 2, 'a version-5 full backup round-trips through SQLite restore');

  db.softDeleteLog(created.id, { ...user, role: 'admin' });
  assert.throws(() => db.saveLog({ ...created, customerName: 'Hidden Row Mutation' }, user, created.id), /in the Bin/);
  assert.equal(db.getLogs().some((x) => x.id === created.id), false, 'a direct upsert cannot edit a soft-deleted row');
} finally {
  if (db) { try { db.close(); } catch {} }
  console.log = originalLog;
  console.warn = originalWarn;
}
process.stdout.write('DB_INTEGRATION_PASS\n');
`;

test('SQLite writes and full restore are atomic in an isolated temporary data directory', { skip: !tsxAvailable && 'tsx is not installed; install dependencies to run the real SQLite integration test' }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-db-integration-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
      cwd: process.cwd(),
      env: { ...process.env, PACE_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, `database child process could not run: ${result.error?.message}`);
    assert.equal(result.status, 0, `database integration failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /DB_INTEGRATION_PASS/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
