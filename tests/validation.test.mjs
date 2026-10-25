import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodeBase64Payload, decodeBase64Strict, validateFullBackupShape, validateSettingsPatch } from '../server/validation.ts';

const columnsByTable = {
  users: ['id', 'username', 'display_name', 'password', 'role', 'disabled'],
  logs: ['id', 'log_no', 'date', 'foreman_name', 'request_type', 'customer_name', 'status'],
  attachments: ['log_id', 'sha256', 'size', 'created_at'],
};

function validBackup() {
  return {
    format: 'pace-it-full-backup', version: 5, appName: 'Pace IT', exportedAt: new Date().toISOString(),
    counts: { users: 1, logs: 1, attachments: 0 },
    tables: {
      users: { columns: ['id', 'username', 'display_name', 'password', 'role', 'disabled'], rows: [['u1', 'admin', 'Admin', 'hash', 'admin', 0]] },
      logs: { columns: ['id', 'log_no', 'date', 'foreman_name', 'request_type', 'customer_name', 'status'], rows: [['l1', 1, '1 Jan 2026', 'f', 'type', 'customer', 'status']] },
      attachments: { columns: ['log_id', 'sha256', 'size', 'data'], rows: [] },
    },
  };
}

const backupOptions = { knownTables: ['users', 'logs', 'attachments', 'sessions'], columnsByTable };

test('strict base64 decoding rejects malformed values that Buffer.from would partially accept', () => {
  assert.equal(decodeBase64Strict('SGVsbG8=').toString('utf8'), 'Hello');
  assert.equal(decodeBase64Payload('data:application/pdf;base64,SGVsbG8=').toString('utf8'), 'Hello');
  for (const bad of ['', 'SGVsbG8', 'SGV$sbG8=', '!!!!', 'SGVsbG8===']) {
    assert.throws(() => decodeBase64Strict(bad), /base64/);
  }
});

test('settings validator accepts the documented range and rejects coercion, arrays, and mass assignment', () => {
  assert.deepEqual(validateSettingsPatch({ formOverdueDays: 3 }), { formOverdueDays: 3 });
  assert.deepEqual(validateSettingsPatch({}), {});
  for (const bad of [null, [], { formOverdueDays: '3' }, { formOverdueDays: 1.5 }, { formOverdueDays: 0 }, { formOverdueDays: 365 }, { formOverdueDays: 3, admin: true }]) {
    assert.throws(() => validateSettingsPatch(bad));
  }
});

test('full backup validator accepts a complete consistent backup', () => {
  assert.equal(validateFullBackupShape(validBackup(), backupOptions).format, 'pace-it-full-backup');
});

test('full backup validator rejects missing tables, mismatched counts, and incompatible table columns', () => {
  const missingTable = validBackup();
  delete missingTable.tables.logs;
  assert.throws(() => validateFullBackupShape(missingTable, backupOptions), /missing table/);

  const wrongCount = validBackup();
  wrongCount.counts.logs = 2;
  assert.throws(() => validateFullBackupShape(wrongCount, backupOptions), /row count mismatch/);

  const noColumns = validBackup();
  noColumns.tables.logs = { columns: ['not_a_real_column'], rows: [] };
  assert.throws(() => validateFullBackupShape(noColumns, backupOptions), /compatible columns|required columns/);
});

test('full backup validator rejects rows that could silently clear a table', () => {
  const backup = validBackup();
  backup.tables.logs = { columns: [], rows: [] };
  assert.throws(() => validateFullBackupShape(backup, backupOptions), /invalid columns/);
});

test('version 5 backups reject missing schema columns and orphaned attachment rows', () => {
  const missingColumn = validBackup();
  missingColumn.tables.users.columns = ['id', 'username', 'display_name', 'password', 'role'];
  missingColumn.tables.users.rows = [['u1', 'admin', 'Admin', 'hash', 'admin']];
  assert.throws(() => validateFullBackupShape(missingColumn, backupOptions), /version 5 schema|account status column/);

  const orphan = validBackup();
  const bytes = Buffer.from('dummy-file');
  orphan.tables.attachments.rows = [['missing-log', crypto.createHash('sha256').update(bytes).digest('hex'), bytes.length, { $b64: bytes.toString('base64') }]];
  orphan.counts.attachments = 1;
  assert.throws(() => validateFullBackupShape(orphan, backupOptions), /missing connection/);
});

test('full backup validator checks attachment bytes, size, and SHA-256 before restore', () => {
  const backup = validBackup();
  const good = Buffer.from('dummy-file');
  const sha = crypto.createHash('sha256').update(good).digest('hex');
  backup.tables.attachments.rows = [['l1', sha, good.length, { $b64: good.toString('base64') }]];
  backup.counts.attachments = 1;
  assert.doesNotThrow(() => validateFullBackupShape(backup, backupOptions));
  backup.tables.attachments.rows[0][3] = { $b64: Buffer.from('altered').toString('base64') };
  assert.throws(() => validateFullBackupShape(backup, backupOptions), /checksum or size mismatch/);
});

test('backup validation rejects binary wrappers outside attachment payloads and preserves legacy schema compatibility', () => {
  const binaryPassword = validBackup();
  binaryPassword.tables.users.rows[0][3] = { $b64: Buffer.from('not a password hash').toString('base64') };
  assert.throws(() => validateFullBackupShape(binaryPassword, backupOptions), /binary data appears in a non-file column/);

  const legacy = validBackup();
  legacy.version = 3;
  delete legacy.appName;
  delete legacy.exportedAt;
  delete legacy.counts;
  legacy.tables.foremen = { columns: ['id', 'name'], rows: [['f1', 'Legacy Foreman']] };
  // Pre-v4 backup files did not require modern metadata or every modern table column.
  assert.doesNotThrow(() => validateFullBackupShape(legacy, { ...backupOptions, knownTables: ['users', 'logs', 'foremen', 'attachments'], columnsByTable: { ...columnsByTable, foremen: ['id', 'name', 'area'] } }));
});
