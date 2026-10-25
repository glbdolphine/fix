import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './server/api';
import { getEdcIndex } from './server/edcIndex';
import { db } from './server/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const certPath = process.env.SSL_CERT || path.resolve(process.env.PACE_DATA_DIR || path.join(__dirname, 'data'), 'certs', 'cert.pem');
  const keyPath = process.env.SSL_KEY || path.resolve(process.env.PACE_DATA_DIR || path.join(__dirname, 'data'), 'certs', 'key.pem');
  const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
  if (useHttps) process.env.PACE_HTTPS = '1'; // the session cookie becomes Secure-only
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.disable('x-powered-by'); // don't announce "Express" to every visitor

  if (useHttps) app.use((_req, res, next) => { res.setHeader('Strict-Transport-Security', 'max-age=15552000'); next(); });

  // Security headers on every response.
  // - nosniff: the browser must trust the declared file type (a download can't be "reinterpreted" as a web page)
  // - X-Frame-Options / frame-ancestors: no other site may show this app inside a frame (clickjacking)
  // - Content-Security-Policy: the page may only run its own scripts and talk to its own server, so an injected
  //   script could neither run nor send data anywhere. Nothing is loaded from outside: fonts and photos are all served by this app.
  //   PACE_CSP=report only reports violations in the browser console instead of blocking; PACE_CSP=off removes it.
  const cspMode = (process.env.PACE_CSP || 'on').toLowerCase();
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const devMode = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // The development server (hot reload) needs inline scripts, so the strict policy is for the built app only.
    if (!devMode && cspMode !== 'off') {
      res.setHeader(cspMode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', CSP);
    }
    next();
  });

  // Extra addresses allowed to send changes (only needed behind a reverse proxy that rewrites the Host header).
  const trustedHosts = (process.env.PACE_TRUSTED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);

  // Cross-site request protection: a change (POST / PUT / PATCH / DELETE) is accepted only when it comes from
  // this app's own pages. A page on another website can't trigger actions here with a signed-in person's cookie.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    // Modern browsers say where a request comes from; "cross-site" is never this app's own page.
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Request blocked: it did not come from this application.' });
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* "null" or malformed */ }
      if (!originHost || (originHost !== req.headers.host && !trustedHosts.includes(originHost))) {
        return res.status(403).json({ error: 'Request blocked: it did not come from this application.' });
      }
    }
    next();
  });

  // Maintenance mode (set by `npm run backup`): while a backup is being copied nothing may be added, edited or
  // deleted. Reading stays possible so people can see the "system under maintenance" message. Checked BEFORE
  // the request body is read, so blocked uploads are not even buffered.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (/^\/auth\/logout\/?$/.test(req.path)) return next();
    const m = db.getMaintenance();
    if (!m) return next();
    res.setHeader('Retry-After', '60');
    return res.status(503).json({ error: 'System under maintenance: a backup is in progress. Nothing can be added, edited or deleted until it finishes (usually a minute). Your screen will unlock by itself.', maintenance: true });
  });

  // Request size limits: only the routes that carry files (PDFs, backups, logs with an attached form)
  // may be big. Everything else is capped at 2 MB, so a stray or hostile request can't eat the memory.
  // Nobody gets a large body read unless they are signed in: the session is checked BEFORE the body is parsed,
  // so a stranger on the network can't make the server buffer 50 MB per request.
  const PUBLIC_API = /^\/auth\/(login|logout)\/?$/;
  app.use('/api', async (req, res, next) => {
    if (PUBLIC_API.test(req.path)) return next();
    const header = req.headers.cookie || '';
    const m = header.match(/(?:^|;\s*)pace_it_session=([a-f0-9]{64})(?:;|$)/);
    if (!m) return next(); // no usable cookie: the route's own check answers 401 (the body is capped at 2 MB below)
    try { await db.ready(); } catch { return next(); }
    const who = db.getUserByToken(m[1]);
    if (who) { (req as any).sessionOk = true; (req as any).sessionAdmin = who.role === 'admin'; }
    next();
  });
  const bigJson = express.json({ limit: '50mb' });
  const smallJson = express.json({ limit: '2mb' });
  // A full backup file carries every attached form, so it can be far bigger than 50 MB. Only a signed-in
  // administrator (checked again by the route itself) gets this larger allowance.
  const restoreJson = express.json({ limit: '450mb' });
  const BIG_ROUTES = /^\/(pdf\/scan|logs|logs\/batch|logs\/restore|targets\/import|import-requests|logs\/[^/]+\/upac-form)\/?$/;
  app.use('/api', (req, res, next) => {
    const signedIn = req.method === 'POST' && (req as any).sessionOk === true;
    if (signedIn && (req as any).sessionAdmin === true && /^\/backup\/restore\/?$/.test(req.path)) return restoreJson(req, res, next);
    const big = signedIn && BIG_ROUTES.test(req.path);
    (big ? bigJson : smallJson)(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // API router
  app.use('/api', apiRouter);

  // Oversized or malformed request bodies get a clear JSON answer instead of an HTML error page
  app.use('/api', (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
    return next(err);
  });

  // Anything else that goes wrong in the API: log the details here, tell the browser only the basics
  // (Express would otherwise send the error text and file paths).
  app.use('/api', (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Pace IT] Unhandled API error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  // Unknown API address: a JSON answer instead of the web page.
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found.' }); });

  // Serve frontend.
  // Default: serve the built app from ./dist (fast, no file watching, no auto-reloads).
  // Development: `npm run dev` starts Vite with hot reload (and never watches ./data).
  const distPath = path.resolve(__dirname, 'dist');
  const wantsDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  const hasBuild = fs.existsSync(path.join(distPath, 'index.html'));
  const serveBuilt = !wantsDev && hasBuild;

  if (!wantsDev && !hasBuild) {
    // Never fall back to the development server on its own: it would hand out files from the project folder
    // (database, secret key, backups, source code) to anyone on the network.
    console.error('[Pace IT] No build found in ./dist. Run "npm run build" first, then "npm start". (Developers: "npm run dev".)');
    process.exit(1);
  }

  if (serveBuilt) {
    console.log('[Pace IT] Serving the built app from ./dist (run "npm run build" after code changes).');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    // Development mode is for the developer's own computer only.
    if (!process.env.HOST && !process.env.PACE_DEV_LAN) process.env.HOST = '127.0.0.1';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        fs: { strict: true, deny: ['data/**', '**/data/**', 'server/**', '.env*', '**/*.sqlite*', '**/*.key', '**/*.pem'] },
        // The database lives in ./data and changes on every save - it must not trigger reloads.
        watch: { ignored: ['**/data/**', '**/*.sqlite*', '**/dist/**'] },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // HTTPS: put a certificate and key at data/certs/cert.pem + key.pem (or point SSL_CERT / SSL_KEY at
  // them) and the server switches to HTTPS by itself. HOST=127.0.0.1 keeps it reachable from this
  // computer only. Default is 0.0.0.0 so colleagues on the office network can open it.
  const HOST = process.env.HOST || '0.0.0.0'; // (development mode defaults to 127.0.0.1, see above)

  let server: http.Server | https.Server;
  if (useHttps) {
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
  } else {
    server = http.createServer(app);
  }

  server.listen(PORT, HOST, () => {
    const scheme = useHttps ? 'https' : 'http';
    console.log(`[Pace IT] Running at ${scheme}://localhost:${PORT}`);
    if (HOST === '0.0.0.0') console.log(`[Pace IT] Reachable from the office network on port ${PORT}`);
    // Load the EDC workbook now so the first Form Maker lookup is instant.
    setTimeout(() => { try { getEdcIndex(); } catch (e) { console.error(e); } }, 50);
  });
}

startServer().catch((err) => {
  console.error('[Pace IT] Failed to start server:', err);
  process.exit(1);
});
