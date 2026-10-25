import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { extractUpacPdf, ExtractedForm } from './pdfExtractor';
import { getEdcIndex, edcIndexSource } from './edcIndex';
import { db, AppUser, FULL_BACKUP_FORMAT, verifyPassword, verifyPasswordAsync, hashPassword, hashPasswordAsync, needsRehash, passwordProblem, ACTIVITY_ACTIONS, SESSION_TTL_MS, SAFE_ATTACHMENT_TYPES } from './db';
import { loadTargets, importTargets, clearTargets } from './targets';
import { fillEdcDocx, sanitizeFilename, normalizeMac, contentDisposition } from './docxFiller';
import { decodeBase64Payload, validateSettingsPatch } from './validation';

const router = Router();

// What the browser is told when something fails. Messages the app wrote on purpose ("Password must be at least
// 8 characters.") are shown as they are. Anything that looks like an internal fault (database, file system,
// programming error) is written to the server console only and the browser gets a plain sentence.
function publicError(err: any, fallback = 'Something went wrong. Please try again.'): string {
  const msg = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  const internal =
    !msg ||
    err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError ||
    /^(ERR_SQLITE|SQLITE|ENOENT|EACCES|EPERM|ENOSPC|EBUSY|EMFILE|EEXIST)/.test(code) ||
    /sqlite|no such (table|column)|constraint failed|\bat\s+\S+\s+\(|node_modules|[A-Za-z]:\\|\/home\/|\/usr\/|ENOENT|EACCES|EPERM/i.test(msg);
  if (internal) {
    console.error('[Pace IT] Internal error:', err);
    return fallback;
  }
  return msg;
}

// Session cookie
const SESSION_COOKIE = 'pace_it_session';
const SESSION_MAX_AGE_MS = SESSION_TTL_MS; // same lifetime as the session stored in the database

function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

function extractToken(req: Request): string {
  return readCookie(req, SESSION_COOKIE);
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Secure-only when the server really runs HTTPS (or a proxy in front does: COOKIE_SECURE=1).
    // Forcing it on plain HTTP would stop the browser from ever sending the cookie back.
    secure: process.env.PACE_HTTPS === '1' || process.env.COOKIE_SECURE === '1',
    path: '/',
  };
}

// Every change (save, edit, delete, approve...) is written to the database file before the
// response goes back, so the moment the user sees "saved" the data is already on disk.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const end = res.end.bind(res) as (...args: any[]) => Response;
    (res as any).end = (...args: any[]) => {
      try { db.flush(); } catch (err) { console.error('[Pace IT] Flush failed:', err); }
      return end(...args);
    };
  }
  next();
});

// Ensure SQLite database is initialized before serving requests
router.use((_req, _res, next) => {
  // Express 4 does not automatically forward rejected async middleware promises.
  void db.ready().then(() => next(), next);
});

// EDC lookups read data/toscrape.xlsx (falls back to data/index.json); see server/edcIndex.ts
function getIndex(): Record<string, any[]> {
  return getEdcIndex();
}

function normalizeKey(value: any): string {
  if (value === null || value === undefined) return '';
  let s = String(value).trim();
  if (/^-?\d+\.0$/.test(s)) {
    s = s.slice(0, -2);
  }
  return s;
}

// Authentication Middleware
export interface AuthenticatedRequest extends Request {
  user?: AppUser;
  token?: string;
}

function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
  const user = db.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
  req.user = user;
  req.token = token;
  next();
}

function adminMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

// Realtime SSE
const MAX_EVENT_STREAMS_PER_USER = 6;
const eventStreams = new Map<string, number>();

router.get('/events', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const uid = req.user!.id;
  if ((eventStreams.get(uid) || 0) >= MAX_EVENT_STREAMS_PER_USER) {
    return res.status(429).json({ error: 'Too many open live-update connections for this account.' });
  }
  eventStreams.set(uid, (eventStreams.get(uid) || 0) + 1);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // A browser that connects (or reconnects) during a backup learns about it immediately.
  const maint = db.getMaintenance();
  if (maint) res.write(`data: ${JSON.stringify({ type: 'maintenance', payload: { on: true, reason: maint.reason, since: maint.since } })}\n\n`);

  const token = req.token || '';
  const stop = () => { try { res.end(); } catch { /* already closed */ } };
  // A stream belongs to a login session: when the session ends (sign-out, password change, account disabled,
  // idle timeout) the stream is closed instead of carrying on with the old permission.
  const onChange = (data: any) => {
    if (!db.isSessionActive(token)) return stop();
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  db.on('change', onChange);

  const heartbeat = setInterval(() => {
    if (!db.isSessionActive(token)) return stop();
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    const left = (eventStreams.get(uid) || 1) - 1;
    if (left <= 0) eventStreams.delete(uid); else eventStreams.set(uid, left);
    clearInterval(heartbeat);
    db.off('change', onChange);
  });
});

// Is the system in maintenance (backup running)? Used by the browser when live updates are unavailable.
router.get('/status', authMiddleware, (_req: Request, res: Response) => {
  const m = db.getMaintenance();
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ maintenance: m ? { on: true, reason: m.reason, since: m.since } : { on: false } });
});

// Rate Limiter for Authentication
interface RateLimitRecord {
  attempts: number;
  lockedUntil: number;
  lastAttempt: number;
}

const MAX_LOGIN_ATTEMPTS = 5;        // wrong passwords for one account
const MAX_LOGIN_ATTEMPTS_PER_IP = 20; // wrong passwords from one computer (all accounts together)
const MAX_LOGIN_ATTEMPTS_ACCOUNT_TOTAL = 60; // wrong passwords for one account from ALL computers together (spread-out guessing)
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const loginAttempts = new Map<string, RateLimitRecord>();

// The address of the computer that is really connected. The X-Forwarded-For header is NOT used: a browser can
// write anything in it, which would let someone dodge the lockout by changing it with every guess.
function getClientIp(req: Request): string {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function checkRateLimit(key: string): { locked: boolean; retryAfterSeconds: number; attempts: number } {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record) return { locked: false, retryAfterSeconds: 0, attempts: 0 };
  if (record.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { locked: true, retryAfterSeconds, attempts: record.attempts };
  }
  if (now - record.lastAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
    return { locked: false, retryAfterSeconds: 0, attempts: 0 };
  }
  return { locked: false, retryAfterSeconds: 0, attempts: record.attempts };
}

function recordFailedLogin(key: string, max = MAX_LOGIN_ATTEMPTS): { locked: boolean; retryAfterSeconds: number; attemptsRemaining: number } {
  const now = Date.now();
  const record = loginAttempts.get(key) || { attempts: 0, lockedUntil: 0, lastAttempt: now };
  record.attempts += 1;
  record.lastAttempt = now;

  if (record.attempts >= max) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    loginAttempts.set(key, record);
    const retryAfterSeconds = Math.ceil(LOCKOUT_DURATION_MS / 1000);
    return { locked: true, retryAfterSeconds, attemptsRemaining: 0 };
  }
  loginAttempts.set(key, record);
  return { locked: false, retryAfterSeconds: 0, attemptsRemaining: max - record.attempts };
}

function recordSuccessfulLogin(key: string): void {
  loginAttempts.delete(key);
}

// Forget old counters so the table can't grow without limit (e.g. many made-up usernames).
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of loginAttempts) {
    if (r.lockedUntil < now && now - r.lastAttempt > ATTEMPT_WINDOW_MS) loginAttempts.delete(k);
  }
}, 5 * 60 * 1000).unref();

// A password that was never issued to anyone. Checked when the username doesn't exist so that "no such user" and
// "wrong password" take the same time to answer.
const DUMMY_HASH = hashPassword('not-a-real-password-' + Math.random());

async function confirmAdminPassword(req: AuthenticatedRequest, res: Response): Promise<boolean> {
  const password = String(req.body?.password ?? '');
  const key = `admin-confirm:${req.user!.id}`;
  const limit = checkRateLimit(key);
  if (limit.locked) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` });
    return false;
  }
  const stored = db.getUserById(req.user!.id);
  if (!password || !stored || !(await verifyPasswordAsync(password, stored.password))) {
    const fail = recordFailedLogin(key);
    if (password) db.logSecurity('admin_confirm_failed', { username: req.user!.username, ip: getClientIp(req) });
    res.status(403).json({ error: password ? `Incorrect admin password. ${fail.attemptsRemaining} attempt${fail.attemptsRemaining === 1 ? '' : 's'} remaining.` : 'Enter your admin password to continue.' });
    return false;
  }
  recordSuccessfulLogin(key);
  return true;
}

// Authentication
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (username.length > 100 || password.length > 200) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }

    const norm = username.trim().toLowerCase().replace(/\s+/g, '_');
    const ip = getClientIp(req);
    // Three counters. The strict one is per account AND computer, so a stranger typing wrong passwords for "admin"
    // from their own computer cannot lock the real administrator out of theirs. The other two stop one computer
    // from trying many accounts, and guessing spread over many computers (a much higher limit).
    const userKey = `login-user:${norm}:${ip}`;
    const ipKey = `login-ip:${ip}`;
    const totalKey = `login-total:${norm}`;

    const lockedStatus = [checkRateLimit(userKey), checkRateLimit(ipKey), checkRateLimit(totalKey)].find((x) => x.locked);
    if (lockedStatus) {
      res.setHeader('Retry-After', lockedStatus.retryAfterSeconds);
      const minutes = Math.ceil(lockedStatus.retryAfterSeconds / 60);
      return res.status(429).json({
        error: `Too many failed login attempts. Temporarily locked for security. Please try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`,
        retryAfter: lockedStatus.retryAfterSeconds,
      });
    }

    const user = db.getUserByUsername(norm);
    const passwordOk = (await verifyPasswordAsync(password, user ? user.password : DUMMY_HASH)) && !!user;
    if (!user || !passwordOk) {
      const failUser = recordFailedLogin(userKey);
      const failIp = recordFailedLogin(ipKey, MAX_LOGIN_ATTEMPTS_PER_IP);
      const failTotal = recordFailedLogin(totalKey, MAX_LOGIN_ATTEMPTS_ACCOUNT_TOTAL);
      db.logSecurity('login_failed', { username: norm.slice(0, 60), ip, detail: user ? 'wrong password' : 'unknown username' });
      const failStatus = failUser.locked ? failUser : failIp.locked ? failIp : failTotal.locked ? failTotal : failUser;
      if (failStatus.locked) {
        db.logSecurity('login_locked', { username: norm.slice(0, 60), ip, detail: failUser.locked ? 'account locked for 15 minutes from this computer' : failIp.locked ? 'this computer locked for 15 minutes' : 'account locked for 15 minutes (guessing from many computers)' });
        res.setHeader('Retry-After', failStatus.retryAfterSeconds);
        const minutes = Math.ceil(failStatus.retryAfterSeconds / 60);
        return res.status(429).json({
          error: `Too many failed login attempts. Account temporarily locked for ${minutes} minute${minutes > 1 ? 's' : ''}.`,
          retryAfter: failStatus.retryAfterSeconds,
        });
      }
      return res.status(401).json({
        error: `Invalid username or password. ${failUser.attemptsRemaining} attempt${failUser.attemptsRemaining === 1 ? '' : 's'} remaining.`,
        attemptsRemaining: failUser.attemptsRemaining,
      });
    }

    if (user.disabled) {
      db.logSecurity('login_disabled', { username: user.username, ip, detail: 'correct password on a disabled account' });
      return res.status(403).json({ error: 'This account has been disabled. Contact an administrator.' });
    }

    recordSuccessfulLogin(userKey);
    if (needsRehash(user.password)) {
      try { db.replacePasswordHash(user.id, await hashPasswordAsync(password)); } catch (e) { console.error('[Pace IT] Could not upgrade a password hash:', e); }
    }
    db.logSecurity('login_ok', { username: user.username, ip });

    const token = db.createSession(user.id);

    // Return the FULL profile, exactly what /auth/me will return on the next reload.
    // Missing fields (photo, phone, email) here is why the avatar fell back to initials
    // until the page was refreshed.
    const fresh = db.getUserById(user.id) || user;
    const profile: AppUser = {
      id: fresh.id,
      username: fresh.username,
      displayName: fresh.displayName,
      role: fresh.role,
      phoneNumber: fresh.phoneNumber,
      email: fresh.email,
      photoUrl: fresh.photoUrl,
      disabled: fresh.disabled,
      createdAt: fresh.createdAt,
    };

    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_MAX_AGE_MS });
    return res.json({ user: profile });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err, 'Login failed.') });
  }
});

router.get('/auth/me', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: req.user });
});

router.put('/auth/profile', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = db.updateUserProfile(req.user!.id, req.body || {});
    return res.json({ ok: true, user: updated });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update profile.') });
  }
});

router.post('/auth/logout', (req: AuthenticatedRequest, res: Response) => {
  const token = extractToken(req);
  if (token) {
    const who = db.getUserByToken(token);
    if (who) db.logSecurity('logout', { username: who.username, ip: getClientIp(req) });
    db.destroySession(token); // really ends the session on the server, not just in the browser
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.json({ ok: true });
});

router.post('/auth/logout-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  db.destroyUserSessions(req.user!.id);
  db.logSecurity('logout_all', { username: req.user!.username, ip: getClientIp(req), detail: 'signed out on every computer' });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.json({ ok: true });
});

router.post('/auth/change-password', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, password } = req.body || {};
    const weak = passwordProblem(password, req.user!.username);
    if (weak) return res.status(400).json({ error: weak });
    // The current password is required, so someone at an unlocked computer can't take over the account.
    const key = `pw-change:${req.user!.id}`;
    const limit = checkRateLimit(key);
    if (limit.locked) {
      const minutes = Math.ceil(limit.retryAfterSeconds / 60);
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` });
    }
    const stored = db.getUserById(req.user!.id);
    if (typeof currentPassword !== 'string' || !currentPassword || !stored || !(await verifyPasswordAsync(currentPassword, stored.password))) {
      const fail = recordFailedLogin(key);
      db.logSecurity('password_change_failed', { username: req.user!.username, ip: getClientIp(req), detail: 'wrong current password' });
      return res.status(403).json({ error: currentPassword ? `Your current password is not correct. ${fail.attemptsRemaining} attempt${fail.attemptsRemaining === 1 ? '' : 's'} remaining.` : 'Enter your current password.' });
    }
    recordSuccessfulLogin(key);
    if (password === currentPassword) {
      return res.status(400).json({ error: 'The new password must be different from the current one.' });
    }
    // Every other sign-in of this account (other computers, a copied cookie) ends now; this one stays.
    db.setUserPassword(req.user!.id, password, req.token);
    db.logSecurity('password_changed', { username: req.user!.username, ip: getClientIp(req), detail: 'other sessions signed out' });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not change the password.') });
  }
});

router.post('/auth/note-password-changed', authMiddleware, (_req: Request, res: Response) => {
  return res.json({ ok: true });
});

// User Management (Admin only)
router.get('/users/avatars', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.listUserAvatars());
});

router.get('/users', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  return res.json(db.listUsers());
});

router.post('/users', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  try {
    const { username, password, displayName } = req.body || {};
    const created = db.createUser(username, password, displayName);
    db.logSecurity('user_created', { username: created.username, ip: getClientIp(req), detail: `created by ${(req as AuthenticatedRequest).user?.username}` });
    return res.json(created);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.post('/users/:id/disable', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { disabled } = req.body || {};
    const target = db.getUserById(id, true);
    db.setUserDisabled(id, Boolean(disabled));
    db.logSecurity(disabled ? 'user_disabled' : 'user_enabled', { username: target?.username, ip: getClientIp(req), detail: `by ${(req as AuthenticatedRequest).user?.username}` });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.post('/admin/users/:id/reset-password', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};
    const target = db.getUserById(id, true);
    const weak = passwordProblem(password, target?.username);
    if (weak) return res.status(400).json({ error: weak });
    db.setUserPassword(id, password); // also signs that account out everywhere
    db.logSecurity('password_reset', { username: target?.username, ip: getClientIp(req), detail: `by ${(req as AuthenticatedRequest).user?.username}; signed out everywhere` });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// Security log (administrator only)
router.get('/admin/security-log', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  return res.json(db.listSecurityEvents(300));
});

// Logs CRUD
const bootId = Math.random().toString(36).slice(2, 8);
let logsCache: { rev: number; json: Buffer; gzip: Buffer } | null = null;

router.get('/logs', authMiddleware, (req: Request, res: Response) => {
  const rev = db.revision;
  if (!logsCache || logsCache.rev !== rev) {
    const json = Buffer.from(JSON.stringify(db.getLogs()));
    logsCache = { rev, json, gzip: zlib.gzipSync(json, { level: 5 }) };
  }
  const etag = `"logs-${bootId}-${rev}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(logsCache.gzip);
  }
  return res.end(logsCache.json);
});

router.post('/logs', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { entry, existingId } = req.body || {};
    if (!entry) return res.status(400).json({ error: 'Connection data is required.' });
    const saved = db.saveLog(entry, req.user!, existingId);
    return res.json(saved);
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.patch('/logs/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const fields = req.body && typeof req.body === 'object' ? req.body.fields : null;
    if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'Fields to update are required.' });
    const saved = db.patchLog(req.params.id, fields, req.user!);
    if (!saved) return res.status(404).json({ error: 'Connection not found.' });
    return res.json(saved);
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.post('/logs/bulk-fill', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { field, items } = req.body || {};
    if (typeof field !== 'string' || !field) return res.status(400).json({ error: 'A field is required.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Nothing to fill.' });
    if (items.length > 5000) return res.status(400).json({ error: 'Too many rows at once (limit 5000).' });
    const result = db.bulkFillField(field, items, req.user!);
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.post('/logs/fix-upazila', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Select at least one connection.' });
    return res.json({ updated: db.syncUpazilasToTargets(req.user!.displayName, ids.map(String)) });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.post('/logs/bulk-term', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, term } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Select at least one connection.' });
    if (ids.length > 10000) return res.status(400).json({ error: 'Too many connections at once (limit 10000).' });
    return res.json(db.bulkSetTerm(ids.map(String), String(term ?? ''), req.user!));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.post('/logs/bulk-foreman', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, foremanId } = req.body || {};
    if (typeof foremanId !== 'string' || !foremanId) return res.status(400).json({ error: 'Choose a foreman.' });
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Select at least one connection.' });
    if (ids.length > 5000) return res.status(400).json({ error: 'Too many connections at once (limit 5000).' });
    return res.json(db.bulkSetForeman(ids.map(String), foremanId, req.user!));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.post('/logs/batch', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Array of entries is required.' });
    }
    const saved = db.saveBatchLogs(entries, req.user!);
    return res.json({ saved, count: saved.length });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// UPAC PDF scanner
router.post('/pdf/scan', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const files: { name?: string; data?: string }[] = Array.isArray(req.body.files) ? req.body.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No PDF files provided.' });
    }

    const results: ExtractedForm[] = [];
    const errors: { fileName: string; error: string }[] = [];

    for (const item of files) {
      const fileName = (typeof item?.name === 'string' ? item.name : 'document.pdf').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'document.pdf';
      if (typeof item?.data !== 'string' || !item.data) {
        errors.push({ fileName, error: 'Empty file.' });
        continue;
      }
      try {
        const bytes = decodeBase64Payload(item.data);
        if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new Error('The file does not appear to be a PDF.');
        results.push(await extractUpacPdf(bytes, fileName));
      } catch (err: any) {
        errors.push({ fileName, error: publicError(err, 'Could not read this PDF.') });
      }
    }

    return res.json({ results, errors });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err, 'PDF scan failed.') });
  }
});

router.delete('/logs/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const success = db.softDeleteLog(id, req.user!);
    return res.json({ ok: success });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.post('/logs/:id/upac-form', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, data, type, size } = req.body || {};
    if (!data) return res.status(400).json({ error: 'Form data is required.' });
    const updated = db.setUpacForm(id, { name: name || 'UPAC_Form.pdf', data, type, size }, req.user!);
    return res.json({ ok: true, log: updated });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Failed to attach UPAC form.') });
  }
});

router.get('/logs/:id/upac-form', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const upac = db.getUpacForm(id);
    if (!upac) {
      return res.status(404).json({ error: 'No UPAC form attached for this connection.' });
    }

    const mime = upac.type && SAFE_ATTACHMENT_TYPES.has(upac.type) ? upac.type : 'application/octet-stream';
    const buffer = upac.buffer;
    const filename = sanitizeFilename(upac.name || 'UPAC_Form.pdf');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err, 'Failed to download UPAC form.') });
  }
});

router.delete('/logs/:id/upac-form', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updated = db.deleteUpacForm(id, req.user!);
    return res.json({ ok: true, log: updated });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Failed to remove UPAC form.') });
  }
});

// Form / bill received marks and admin approvals
router.get('/approvals', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.listApprovals());
});

router.post('/approvals/request', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Nothing to mark.' });
    return res.json(db.requestMarks(items, req.user!));
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.post('/approvals/decide', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, all, approve } = req.body || {};
    return res.json(db.decideApprovals({ ids: Array.isArray(ids) ? ids.map(String) : [], all: Boolean(all), approve: approve !== false }, req.user!));
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.delete('/approvals/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ ok: db.withdrawApproval(req.params.id, req.user!) });
});

router.post('/logs/clear-all', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await confirmAdminPassword(req, res))) return;
    const count = db.softDeleteAllLogs(req.user!);
    db.logSecurity('clear_all', { username: req.user!.username, ip: getClientIp(req), detail: `${count} connections moved to the bin` });
    return res.json({ cleared: count });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.post('/logs/restore', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { logs, merge, local } = req.body || {};
    if (!Array.isArray(logs)) return res.status(400).json({ error: 'Connections array is required.' });
    // The admin password is always asked, with ONE exception that the server checks for itself instead of trusting
    // the browser: the one-time import of an old browser's data (local + merge) is allowed only while the database
    // has no connections at all (a brand-new install), when there is nothing it could overwrite.
    const emptyInstall = Boolean(local) && Boolean(merge) && db.countLiveLogs() === 0;
    if (!emptyInstall && !(await confirmAdminPassword(req, res))) return;
    const count = db.restoreLogs(logs, Boolean(merge), req.user!);
    db.logSecurity('restore', { username: req.user!.username, ip: getClientIp(req), detail: `${logs.length} connections, ${merge ? 'merged' : 'replaced all'}${emptyInstall ? ' (empty install)' : ''}` });
    return res.json({ total: count });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// Full backup, full restore and full wipe (administrator only). These work on the WHOLE database: connections
// (with bills, forms, terms, categories, the bin), foremen and teams, approvals, import requests, saved values,
// the activity feed, user accounts, the security log, targets, attached forms and settings.
router.get('/backup/full', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tooBig = 'The database is too big for a single backup file. Use "npm run backup -- <folder>" on the server instead.';
  try {
    let body: string;
    let counts: Record<string, number>;
    try {
      const backup = db.exportFull();
      counts = backup.counts;
      body = JSON.stringify(backup);
    } catch (e) {
      if (e instanceof RangeError) return res.status(507).json({ error: tooBig });
      throw e;
    }
    db.logSecurity('backup_download', { username: req.user!.username, ip: getClientIp(req), detail: `${counts.logs ?? 0} connections, ${counts.activity ?? 0} activity entries` });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="PaceIT_Full_Backup_${day}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(body);
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.post('/backup/restore', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await confirmAdminPassword(req, res))) return;
    const backup = req.body?.backup;
    if (!backup || backup.format !== FULL_BACKUP_FORMAT) return res.status(400).json({ error: 'This is not a full Pace IT backup file.' });
    const result = await db.restoreFull(backup, req.user!);
    db.logSecurity('restore_full', { username: req.user!.username, ip: getClientIp(req), detail: `${result.counts.logs ?? 0} connections, ${result.counts.foremen ?? 0} foremen, ${result.counts.activity ?? 0} activity entries; safety copy ${result.safetyCopy}` });
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'The backup could not be restored. Nothing was changed.') });
  }
});

router.post('/backup/wipe', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (String(req.body?.phrase ?? '').trim() !== 'WIPE') return res.status(400).json({ error: 'Type WIPE (in capital letters) to confirm.' });
    if (!(await confirmAdminPassword(req, res))) return;
    const result = await db.wipeAll();
    db.logSecurity('wipe_all', { username: req.user!.username, ip: getClientIp(req), detail: `${result.removed.logs ?? 0} connections, ${result.removed.foremen ?? 0} foremen, ${result.removed.activity ?? 0} activity entries deleted; safety copy ${result.safetyCopy}` });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err, 'The wipe could not be completed. Nothing was changed.') });
  }
});

// Small shared settings (kept in the database, not in each browser).
router.get('/settings', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.getPublicSettings());
});

router.put('/settings', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    // The API reference deliberately allows any signed-in user to adjust this shared setting. Validate the
    // payload strictly so coercion and unexpected fields cannot mutate unrelated server-owned settings.
    const patch = validateSettingsPatch(req.body);
    if (patch.formOverdueDays !== undefined) db.setFormOverdueDays(patch.formOverdueDays);
    return res.json(db.getPublicSettings());
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

// Target institutes (Targets tab). Stored in the database (targets table).
router.get('/targets', authMiddleware, (_req: Request, res: Response) => {
  return res.json(loadTargets());
});

router.post('/targets/import', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { rows, replace } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'A list of rows is required.' });
    return res.json(importTargets(rows, { replace: replace === true }));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.delete('/targets', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  try {
    return res.json({ cleared: clearTargets() });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// CSV import requests
router.get('/import-requests', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const all = db.listImportRequests();
  return res.json(req.user!.role === 'admin' ? all : all.filter((r) => (r.requestedById ? r.requestedById === req.user!.id : r.requestedBy === req.user!.displayName)));
});

router.post('/import-requests', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: 'Nothing to import.' });
    return res.json(db.createImportRequest(entries, req.user!));
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

router.post('/import-requests/:id/decide', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(db.decideImportRequest(req.params.id, req.body?.approve !== false, req.user!));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.delete('/import-requests/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ ok: db.withdrawImportRequest(req.params.id, req.user!) });
});

// Foremen CRUD
router.get('/foremen', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.getForemen());
});

router.post('/foremen', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const created = db.createForeman(req.body, req.user!);
    return res.json(created);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.put('/foremen/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const body = { ...(req.body || {}) };
    // Only an administrator may grant or change the "own broadband" exception.
    if (req.user?.role !== 'admin') {
      delete body.roam;
      delete body.roamAreas;
    }
    const updated = db.updateForeman(id, body);
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.delete('/foremen/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const success = db.softDeleteForeman(id, req.user!);
    return res.json({ ok: success });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// Foreman teams (members working under a foreman)
router.get('/team-members', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.getTeamMembers());
});

router.post('/team-members', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(db.createTeamMember(req.body || {}, req.user!));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.put('/team-members/:id', authMiddleware, (req: Request, res: Response) => {
  try {
    return res.json(db.updateTeamMember(req.params.id, req.body || {}));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err) });
  }
});

router.delete('/team-members/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ ok: db.softDeleteTeamMember(req.params.id, req.user!) });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// Admin Bin
router.get('/bin', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  return res.json(db.getBin());
});

router.post('/bin/logs/:id/restore', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const ok = db.restoreBinLog(req.params.id);
  return res.json({ ok });
});

router.post('/bin/foremen/:id/restore', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const ok = db.restoreBinForeman(req.params.id);
  return res.json({ ok });
});

router.delete('/bin/logs/:id', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const ok = db.purgeBinLog(req.params.id, (req as AuthenticatedRequest).user!);
  if (ok) db.logSecurity('bin_purge', { username: (req as AuthenticatedRequest).user!.username, ip: getClientIp(req), detail: 'one connection permanently deleted' });
  return res.json({ ok });
});

router.delete('/bin/foremen/:id', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const ok = db.purgeBinForeman(req.params.id, (req as AuthenticatedRequest).user!);
  return res.json({ ok });
});

router.delete('/bin', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const count = db.emptyBin((req as AuthenticatedRequest).user!);
  if (count) db.logSecurity('bin_emptied', { username: (req as AuthenticatedRequest).user!.username, ip: getClientIp(req), detail: `${count} item(s) permanently deleted` });
  return res.json({ purged: count });
});

// Suggestions
router.get('/suggestions', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.getSuggestions());
});

router.post('/suggestions', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Invalid suggestions.' });
    const clean: Record<string, string[]> = {};
    for (const [field, values] of Object.entries(body)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(field) || !Array.isArray(values)) continue;
      clean[field] = values.filter((v) => typeof v === 'string').map((v: string) => v.slice(0, 500)).slice(0, 2000);
    }
    db.saveSuggestions(clean as any);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// Activity
router.get('/activity', authMiddleware, (_req: Request, res: Response) => {
  return res.json(db.getActivity());
});

router.post('/activity', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, logNo, customer, detail } = req.body || {};
    // The browser may only add plain "edited / created / deleted / restored" lines; the sensitive kinds (user
    // changes, clear, purge, password reset) are written by the server itself. Text is trimmed so the feed can't be flooded.
    const USER_ACTIONS = new Set(['created', 'edited', 'deleted', 'restored']);
    const clip = (v: unknown, n: number) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
    db.addActivity({
      by: req.user!.displayName,
      action: (USER_ACTIONS.has(action) && (ACTIVITY_ACTIONS as readonly string[]).includes(action) ? action : 'edited') as any,
      logNo: clip(logNo, 40),
      customer: clip(customer, 200),
      detail: clip(detail, 500),
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err) });
  }
});

// Form Maker: Meta, Lookup, and Generate
const FORM_FIELDS = [
  { key: 'name', label: 'প্রতিষ্ঠানের নাম (Institute Name)', default: '' },
  { key: 'mobile', label: 'মোবাইল নাম্বার (Mobile)', default: '' },
  { key: 'union', label: 'ইউনিয়নের নাম (Union)', default: '' },
  { key: 'upazila', label: 'উপজেলা/থানা (Upazila)', default: '' },
  { key: 'source_no', label: 'EDC Book No. / সুত্র নং', default: '' },
  { key: 'connection_nms', label: 'সংযোগ/NMS আইডি', default: '' },
  { key: 'institution_code', label: 'প্রতিষ্টানের কোড (EMIS/EIIN/OTHERS)', default: '' },
  { key: 'lat_long', label: 'Lat & Long', default: '' },
  { key: 'router_serial', label: 'রাউটার সিরিয়াল নাম্বার', default: '' },
  { key: 'router_mac', label: 'MAC address', default: '' },
  { key: 'cable_brand', label: 'Optical Fiber Cable Brand', default: 'BRB' },
  { key: 'cable_qty', label: 'Optical Fiber Cable Qty (meters)', default: '1500' },
];

router.get('/meta', authMiddleware, (_req: Request, res: Response) => {
  return res.json({ fields: FORM_FIELDS });
});

router.get('/lookup', authMiddleware, (req: Request, res: Response) => {
  const edcRaw = req.query.edc as string | undefined;
  const key = normalizeKey(edcRaw);
  if (!key) return res.json({ matches: [] });

  const index = getIndex();
  const matches = Object.prototype.hasOwnProperty.call(index, key) ? index[key] : [];
  return res.json({ matches, source: edcIndexSource(), total: Object.keys(index).length });
});

router.post('/generate', authMiddleware, (req: Request, res: Response) => {
  try {
    const { data, date } = req.body || {};
    if (!date) return res.status(400).json({ error: 'Valid date is required.' });

    const normalizedData: Record<string, string> = {};
    for (const field of FORM_FIELDS) {
      const val = data && data[field.key] !== undefined ? String(data[field.key]).trim() : '';
      normalizedData[field.key] = val || field.default;
    }

    if (normalizedData.router_mac) {
      normalizedData.router_mac = normalizeMac(normalizedData.router_mac);
    }

    const docBuffer = fillEdcDocx(normalizedData, date);
    const baseName = sanitizeFilename(normalizedData.connection_nms || normalizedData.source_no || normalizedData.name || 'form');
    const filename = `${baseName}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('X-Filename', encodeURIComponent(filename));
    res.setHeader('X-Mac', normalizedData.router_mac || '');
    return res.send(docBuffer);
  } catch (err: any) {
    console.error('Docx generation error:', err);
    return res.status(500).json({ error: publicError(err, 'Failed to generate form.') });
  }
});

export default router;