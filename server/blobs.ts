import fs from 'fs';
import path from 'path';
import { decodeBase64Payload } from './validation.ts';
import crypto from 'crypto';

// Attached forms are stored as plain files on disk, named by the SHA-256 of their content:
//   <data>/files/blobs/ab/abcdef...(64 hex)
// The database only keeps the hash and the size. Two consequences:
//   * a file never changes after it is written, so a backup only has to copy files it does not have yet;
//   * the same form attached twice is stored once.

const SHA_RE = /^[a-f0-9]{64}$/;

export function isSha(s: unknown): s is string {
  return typeof s === 'string' && SHA_RE.test(s);
}

export function blobRoot(dataDir: string): string {
  return path.join(dataDir, 'files', 'blobs');
}

export function blobPath(root: string, sha: string): string {
  if (!isSha(sha)) throw new Error('Invalid file hash.');
  return path.join(root, sha.slice(0, 2), sha);
}

export function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Writes the bytes under their hash. Atomic (temp file, flush, rename). Does nothing when the file is already there. */
export function writeBlob(dataDir: string, bytes: Buffer): { sha256: string; size: number } {
  const sha = sha256Of(bytes);
  const root = blobRoot(dataDir);
  const final = blobPath(root, sha);
  // A hash-named file may already exist but have been damaged on disk. Size alone is not proof of integrity.
  if (fs.existsSync(final)) {
    const existing = fs.readFileSync(final);
    if (sha256Of(existing) === sha) return { sha256: sha, size: bytes.length };
  }

  fs.mkdirSync(path.dirname(final), { recursive: true });
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    // POSIX rename replaces atomically. Windows may refuse to rename over an existing corrupt file, so
    // move that file aside only after the replacement bytes have been flushed, then restore it if needed.
    try {
      fs.renameSync(tmp, final);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!fs.existsSync(final) || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String(code))) throw error;
      const quarantine = `${final}.corrupt-${process.pid}-${Date.now()}`;
      fs.renameSync(final, quarantine);
      try {
        fs.renameSync(tmp, final);
      } catch (replaceError) {
        try { fs.renameSync(quarantine, final); } catch { /* keep the quarantined original for manual recovery */ }
        throw replaceError;
      }
      try { fs.unlinkSync(quarantine); } catch { /* a stale quarantined copy is harmless; maintenance can clean it */ }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed or removed */ }
  }
  return { sha256: sha, size: bytes.length };
}

/** The file's bytes, or null when it is missing. Throws when the file exists but its content no longer matches its hash. */
export function readBlob(dataDir: string, sha: string): Buffer | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(blobPath(blobRoot(dataDir), sha));
  } catch {
    return null;
  }
  if (sha256Of(bytes) !== sha) throw new Error(`The stored file ${sha.slice(0, 12)}... is damaged (its content does not match its hash).`);
  return bytes;
}

export interface BlobInfo { sha: string; file: string; size: number; mtimeMs: number }

/** Every stored file in a blobs folder (leftover .tmp files are skipped). */
export function* listBlobs(root: string): Generator<BlobInfo> {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    if (!/^[a-f0-9]{2}$/.test(d)) continue;
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!isSha(n) || n.slice(0, 2) !== d) continue;
      const file = path.join(root, d, n);
      try {
        const st = fs.statSync(file);
        yield { sha: n, file, size: st.size, mtimeMs: st.mtimeMs };
      } catch { /* vanished */ }
    }
  }
}

export function removeStaleTmp(root: string): void {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.tmp')) continue;
      const f = path.join(root, d, n);
      try { if (Date.now() - fs.statSync(f).mtimeMs > 3600_000) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
}

// Attached forms: what we accept and how big. The file type is decided from the file's own first bytes,
// never from the name or type the browser claims, so a renamed script or web page can't be stored as a "PDF".
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
export function sniffAttachment(b: Buffer): string | null {
  if (b.subarray(0, 1024).includes('%PDF-', 0, 'latin1')) return 'application/pdf';
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/msword';
  return null;
}
export const SAFE_ATTACHMENT_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export function decodeAttachment(data: string): Buffer {
  return decodeBase64Payload(data);
}
