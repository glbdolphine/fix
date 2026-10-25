import crypto from 'node:crypto';

/** Strictly decodes canonical standard base64. Buffer.from(..., 'base64') alone silently ignores invalid characters. */
export function decodeBase64Strict(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('File data is not valid base64.');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('File data is not valid base64.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error('File data is not valid base64.');
  }
  return bytes;
}

/** Accepts the bare base64 or data-URL representations used by the existing attachment APIs. */
export function decodeBase64Payload(value: string): Buffer {
  if (typeof value !== 'string') throw new Error('File data is required.');
  const match = /^data:[^;,]*;base64,([\s\S]*)$/.exec(value);
  return decodeBase64Strict(match ? match[1] : value);
}

/** Validate the only setting currently writable by the public settings endpoint. */
export function validateSettingsPatch(input: unknown): { formOverdueDays?: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Settings must be a JSON object.');
  }
  const body = input as Record<string, unknown>;
  const unexpected = Object.keys(body).filter((key) => key !== 'formOverdueDays');
  if (unexpected.length) throw new Error(`Unexpected setting field: ${unexpected[0]}.`);
  if (body.formOverdueDays === undefined) return {};
  const days = body.formOverdueDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 364) {
    throw new Error('Enter a whole number of days between 1 and 364.');
  }
  return { formOverdueDays: days };
}

export interface FullBackupValidationOptions {
  /** Current user tables and their real column names. */
  knownTables: readonly string[];
  columnsByTable: Readonly<Record<string, readonly string[]>>;
}

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  users: ['id', 'username', 'display_name', 'password', 'role'],
  logs: ['id', 'log_no', 'date', 'foreman_name', 'request_type', 'customer_name', 'status'],
  foremen: ['id', 'name', 'created_at'],
  team_members: ['id', 'foreman_id', 'name', 'created_at'],
  approvals: ['id', 'log_id', 'kind', 'action', 'requested_by', 'requested_at', 'status'],
  import_requests: ['id', 'requested_by', 'requested_at', 'status'],
  suggestions: ['field', 'values_json'],
  activity: ['id', 'at', 'by_user', 'action'],
  security_events: ['id', 'at', 'type'],
  settings: ['key'],
  targets: ['position', 'data'],
  attachments: ['log_id'],
};
const SHA256_RE = /^[a-f0-9]{64}$/;
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeBackupBytes(value: unknown, table: string): Buffer {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.$b64 !== 'string') {
    throw new Error(`The backup is damaged (invalid binary value in "${table}").`);
  }
  try {
    return decodeBase64Strict(value.$b64);
  } catch {
    throw new Error(`The backup is damaged (invalid base64 data in "${table}").`);
  }
}

/**
 * Validate a full backup before any live tables are deleted. Older format versions remain supported, but a current
 * version must contain every table/count and every attached form with a verified size and checksum.
 */
export function validateFullBackupShape(input: unknown, options: FullBackupValidationOptions): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error('This is not a full Pace IT backup file.');
  }
  if (input.format !== 'pace-it-full-backup') {
    throw new Error('This is not a full Pace IT backup file.');
  }
  // Narrow the nested untrusted value once, then use the narrowed record throughout.
  // TypeScript does not preserve the property guard across the `backup` alias.
  const tableValue = input.tables;
  if (!isRecord(tableValue)) {
    throw new Error('This is not a full Pace IT backup file.');
  }
  const backup: Record<string, unknown> = input;
  const tables: Record<string, unknown> = tableValue;
  const version = backup.version === undefined ? 1 : backup.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 5) {
    throw new Error('This backup uses an unsupported or invalid format version.');
  }
  const currentFormat = version >= 4;
  const strictCurrentSchema = version >= 5;
  if (currentFormat) {
    if (backup.appName !== 'Pace IT' || typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt))) {
      throw new Error('The backup metadata is incomplete or invalid.');
    }
    if (!isRecord(backup.counts)) throw new Error('The backup is missing its table counts.');
  }

  const known = new Set(options.knownTables);
  for (const [name, rawTable] of Object.entries(tables)) {
    if (name === 'sessions' || !known.has(name)) continue;
    if (!isRecord(rawTable) || !Array.isArray(rawTable.columns) || !Array.isArray(rawTable.rows)) {
      throw new Error(`The backup is damaged (table "${name}").`);
    }
    const columns = rawTable.columns;
    if (columns.length === 0 || columns.length > 256 || columns.some((c) => typeof c !== 'string' || c.length === 0) || new Set(columns).size !== columns.length) {
      throw new Error(`The backup is damaged (invalid columns in "${name}").`);
    }
    const colNames = columns as string[];
    const actual = options.columnsByTable[name] || [];
    if (!colNames.some((column) => actual.includes(column) || (name === 'attachments' && column === 'data'))) {
      throw new Error(`The backup is damaged (table "${name}" has no compatible columns).`);
    }
    // Formats 1–3 predate some schema columns. Keep their compatibility path permissive about those columns,
    // while still requiring a non-empty, compatible schema above; formats 4+ have explicit metadata/counts.
    const required = currentFormat ? (REQUIRED_COLUMNS[name] || []) : [];
    if (required.some((column) => !colNames.includes(column))) {
      throw new Error(`The backup is damaged (table "${name}" is missing required columns).`);
    }
    if (strictCurrentSchema) {
      // Version 5 snapshots all the real columns, making accidental/truncated column lists detectable.
      // Attached form bytes travel in `data`, while the restore stamps created_at as part of the transaction.
      const expected = name === 'attachments'
        ? actual.filter((column) => column !== 'created_at').concat('data')
        : [...actual];
      if (colNames.length !== expected.length || expected.some((column) => !colNames.includes(column)) || colNames.some((column) => !expected.includes(column))) {
        throw new Error(`The backup is damaged (table "${name}" does not match the version 5 schema).`);
      }
    }
    if (strictCurrentSchema && name === 'users' && !colNames.includes('disabled')) {
      throw new Error('The backup is damaged (user table is missing the account status column).');
    }
    if (currentFormat && name === 'attachments' && ['sha256', 'size', 'data'].some((column) => !colNames.includes(column))) {
      throw new Error('The backup is damaged (attached forms are missing their checksums or contents).');
    }

    for (const row of rawTable.rows) {
      if (!Array.isArray(row) || row.length !== colNames.length) {
        throw new Error(`The backup is damaged (a row of "${name}" has the wrong size).`);
      }
      for (let index = 0; index < row.length; index++) {
        const value = row[index];
        if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
        if (typeof value === 'number' && Number.isFinite(value)) continue;
        if (isRecord(value) && typeof value.$b64 === 'string') {
          // Attachment bytes are the only BLOB column in this database. Do not bind attacker-supplied
          // byte arrays into passwords, settings or other text/integer fields during a restore.
          if (name !== 'attachments' || colNames[index] !== 'data') {
            throw new Error(`The backup is damaged (binary data appears in a non-file column of "${name}").`);
          }
          const bytes = decodeBackupBytes(value, name);
          if (bytes.length > ATTACHMENT_MAX_BYTES) {
            throw new Error(`The backup is damaged (an attached form in "${name}" exceeds the 20 MiB per-file limit).`);
          }
          continue;
        }
        throw new Error(`The backup is damaged (invalid value in "${name}").`);
      }
    }

    if (currentFormat && name === 'attachments') {
      const logIdIndex = colNames.indexOf('log_id');
      const hashIndex = colNames.indexOf('sha256');
      const sizeIndex = colNames.indexOf('size');
      const dataIndex = colNames.indexOf('data');
      for (const row of rawTable.rows as unknown[][]) {
        const logId = String(row[logIdIndex] ?? '');
        const hash = row[hashIndex];
        const size = row[sizeIndex];
        if (typeof hash !== 'string' || !SHA256_RE.test(hash) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > ATTACHMENT_MAX_BYTES) {
          throw new Error(`The backup is damaged (invalid attached-form metadata for connection ${logId || 'unknown'}).`);
        }
        const bytes = decodeBackupBytes(row[dataIndex], name);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== size || digest !== hash) {
          throw new Error(`The backup is damaged (attached form checksum or size mismatch for connection ${logId || 'unknown'}).`);
        }
      }
    }

    if (isRecord(backup.counts) && backup.counts[name] !== undefined) {
      const count = backup.counts[name];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count !== rawTable.rows.length) {
        throw new Error(`The backup is damaged (row count mismatch for "${name}").`);
      }
    }
  }

  if (!tables.users || !known.has('users')) {
    throw new Error('The backup has no user accounts.');
  }
  if (strictCurrentSchema) {
    const logs = tables.logs;
    const attachments = tables.attachments;
    if (isRecord(logs) && Array.isArray(logs.columns) && Array.isArray(logs.rows) && isRecord(attachments) && Array.isArray(attachments.columns) && Array.isArray(attachments.rows)) {
      const logIdIndex = (logs.columns as string[]).indexOf('id');
      const attachmentLogIdIndex = (attachments.columns as string[]).indexOf('log_id');
      const logIds = new Set((logs.rows as unknown[][]).map((row) => String(row[logIdIndex] ?? '')));
      for (const row of attachments.rows as unknown[][]) {
        const logId = String(row[attachmentLogIdIndex] ?? '');
        if (!logId || !logIds.has(logId)) {
          throw new Error(`The backup is damaged (attached form refers to missing connection ${logId || 'unknown'}).`);
        }
      }
    }
  }

  if (currentFormat) {
    for (const name of options.knownTables) {
      if (name !== 'sessions' && !Object.prototype.hasOwnProperty.call(tables, name)) {
        throw new Error(`The backup is incomplete (missing table "${name}").`);
      }
      if (!isRecord(backup.counts) || typeof backup.counts[name] !== 'number' || !Number.isSafeInteger(backup.counts[name]) || Number(backup.counts[name]) < 0) {
        if (name !== 'sessions') throw new Error(`The backup is missing a valid count for "${name}".`);
      }
    }
  }

  const users = tables.users;
  if (!isRecord(users) || !Array.isArray(users.columns) || !Array.isArray(users.rows)) {
    throw new Error('The backup has no valid user table.');
  }
  const userColumns = users.columns as string[];
  const roleIndex = userColumns.indexOf('role');
  const disabledIndex = userColumns.indexOf('disabled');
  const hasAdmin = users.rows.some((row) => Array.isArray(row) && row[roleIndex] === 'admin' && (disabledIndex < 0 || !Number(row[disabledIndex] || 0)));
  if (roleIndex < 0 || !hasAdmin) {
    throw new Error('This backup has no active administrator account, so restoring it would lock everyone out.');
  }
  return backup;
}
