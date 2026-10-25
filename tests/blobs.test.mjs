import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobPath, blobRoot, readBlob, sha256Of, writeBlob } from '../server/blobs.ts';

test('content-addressed blob writes verify existing bytes and repair same-size corruption', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-blobs-'));
  try {
    const payload = Buffer.from('verified attachment fixture');
    const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
    assert.deepEqual(writeBlob(dataDir, payload), { sha256: expectedSha, size: payload.length });
    assert.deepEqual(readBlob(dataDir, expectedSha), payload);

    const file = blobPath(blobRoot(dataDir), expectedSha);
    const corrupt = Buffer.from('corrupt attachment fixtures'); // deliberately the same byte length
    assert.equal(corrupt.length, payload.length);
    fs.writeFileSync(file, corrupt);
    assert.notEqual(sha256Of(fs.readFileSync(file)), expectedSha);

    assert.deepEqual(writeBlob(dataDir, payload), { sha256: expectedSha, size: payload.length });
    assert.deepEqual(readBlob(dataDir, expectedSha), payload, 'a repeat upload/restore must not silently bless a same-size corrupt blob');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
