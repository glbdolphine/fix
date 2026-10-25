import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync,
  isPasswordHash, needsRehash, passwordProblem, cleanPhotoUrl, randomPassword,
} from '../server/passwords.ts';

test('scrypt password hashes are salted, non-reversible, and verify correctly', async () => {
  const first = hashPassword('Sufficiently-long test password!');
  const second = hashPassword('Sufficiently-long test password!');
  assert.notEqual(first, second, 'each password hash must use a random salt');
  assert.equal(isPasswordHash(first), true);
  assert.equal(needsRehash(first), false);
  assert.equal(needsRehash('scrypt$16384$00$00'), true);
  assert.equal(verifyPassword('Sufficiently-long test password!', first), true);
  assert.equal(verifyPassword('wrong password', first), false);
  assert.equal(verifyPassword('', first), false);
  assert.equal(verifyPassword('whatever', 'not-a-hash'), false);
  assert.equal(verifyPassword('whatever', 'scrypt$999999999$bad$bad'), false);
  assert.equal(await verifyPasswordAsync('Sufficiently-long test password!', first), true);
  assert.equal(await verifyPasswordAsync('wrong password', first), false);

  const asyncHash = await hashPasswordAsync('Another test password!');
  assert.equal(verifyPassword('Another test password!', asyncHash), true);
});

test('password policy rejects common, short, repeated, username-containing and oversized values', () => {
  for (const password of [undefined, null, 12345, 'short', 'password123', 'aaaaaaaaaa', 'operatorSecret123']) {
    assert.equal(typeof passwordProblem(password, 'operator'), 'string');
  }
  assert.equal(passwordProblem('A different unique phrase 42', 'operator'), null);
  assert.match(passwordProblem('A different unique phrase 42'.repeat(10)), /too long/);
});

test('photo URL validator permits only bounded inline image data URLs', () => {
  assert.equal(cleanPhotoUrl(undefined), '');
  assert.equal(cleanPhotoUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  for (const invalid of ['https://example.com/a.png', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA']) {
    assert.throws(() => cleanPhotoUrl(invalid));
  }
});

test('generated account-reset passwords use the supported character set and expected length', () => {
  const password = randomPassword();
  assert.equal(password.length, 14);
  assert.match(password, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/);
});
