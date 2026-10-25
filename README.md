# Pace IT Management

Internal web application for tracking institute internet connections (EDC / UPAC), the foremen who install them, form and bill reconciliation, and the follow-up on each connection. It runs on a single office machine; users connect through a browser.

## Architecture

```
Browser (React)  <── JSON over /api ──>  Node + Express  ──>  SQLite (data/pace_it.sqlite)
                 <── Server-Sent Events (live updates) ──
```

- One server and one database file; changes made by one user appear on every connected screen.
- Database: Node's built-in `node:sqlite`. Everything the app stores (connections, bills and forms, foremen, approvals, activity, targets, settings) lives in this one small database. The attached UPAC forms are files on disk named by their SHA-256 (`files/blobs/`); the database keeps only the hash and size.
- The server also parses UPAC PDFs, fills the Word form template and creates database backups.

## Features

| Screen | Purpose |
|---|---|
| Dashboard | Counts, recent connections, team activity, data completeness |
| Connection Records | Search, filter, sort, print, export (PDF / Excel), CSV import, bulk fill (fields, foreman, term), per-record history |
| Forms | Track paper forms sent and received per foreman |
| Bills | Track bills received per month |
| Requests | Admin approval queue for form/bill marks and CSV imports made by regular users |
| Form Maker | Look up an institute by EDC number and generate the filled Word form |
| Foremen | Foreman directory, teams and supply numbers |
| Coverage | Connections per upazila and union |
| Targets | Target institute list compared with connected institutes |
| Admin | Accounts, bin (soft-deleted items), security, backup and restore, audit log |

Business rules:

- Regular users cannot mark a form or bill as received directly; the mark becomes a request for an admin to approve. CSV imports follow the same flow.
- Deletion is soft. Deleted records go to the admin bin and can be restored or removed permanently by an admin.
- Destructive admin actions (clear all data, restore from backup) require the admin password again.
- Changing a password needs the current password and signs the account out on its other computers; an admin reset signs that account out everywhere.
- Sign-ins, wrong passwords, lockouts, password changes and restores are recorded in Admin → Security → Security log.
- Attached forms must be PDF, JPG/PNG or Word files up to 20 MB.
- Every change is recorded in the record history and the shared activity feed.
- Categories are detected automatically from the institute name unless set manually.
- Timestamps are displayed in Asia/Dhaka time.

## Requirements

Node.js 22.16 or newer (`node -v`).

## Getting started

```bash
npm install
npm run build
npm start            # http://localhost:3000  (set PORT to change)
```

Development with hot reload: `npm run dev`. Type check: `npm run lint`. Regression tests: `npm test`.

On the first start an `admin` user is created with a random password that is printed once in the terminal. Change it after signing in.

Start the server from the directory that contains `package.json`; `data/` is resolved relative to the working directory. Run one server per `data` directory, on a local disk.

### Data directory

| Path | Description |
|---|---|
| `pace_it.sqlite` | Database (created automatically) |
| `files/blobs/ab/<sha256>` | The attached forms, one immutable file per content hash. Never edit or rename them. A form detached in the app stays on disk until no database row and no kept backup refers to it (and it is 30 days old); the nightly job then removes it |
| `toscrape.xlsx` | EDC institute list used by Form Maker and the PDF reader. Must be provided; can be replaced without a restart |
| `index.json` | Fallback copy of the institute list, used only when no `.xlsx` is present |
| `pace_it_secret.key` | Key used to protect session records (created automatically); keep it private, deleting it signs everyone out |
| `certs/cert.pem`, `certs/key.pem` | Optional. When both exist the server switches to HTTPS |
| `backups/` | Automatic daily database snapshot, made by a separate helper process: ONE per calendar day (the newest 30 daily copies plus one per week for 26 weeks are kept). Also `daily-state.json`, `backup-status.json`, `extras/` (secret key, institute list) and, when something needs attention, `!BACKUP-WARNING.txt` / `!DATABASE-PROBLEM.txt`. Same disk as the data, so it does not replace the second-drive copy below |
| `.maintenance` | Temporary lock file made by `npm run restore` only. Backups never close the website any more |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local only) |
| `SSL_CERT`, `SSL_KEY` | `data/certs/*` | Paths to the TLS certificate and key |
| `COOKIE_SECURE` | unset | Set to `1` when a reverse proxy provides HTTPS |
| `PACE_CSP` | `on` | `report` = the browser only reports Content-Security-Policy problems in its console (use this if a page ever looks broken after an update), `off` = no policy |
| `PACE_TRUSTED_HOSTS` | unset | Extra `host:port` values allowed to send changes, only needed behind a reverse proxy that rewrites the Host header |
| `PACE_BACKUP_DIR` | unset | A SECOND physical drive or folder (e.g. `E:\`). When set, the daily helper also mirrors the database, the new attached forms, the secret key and the institute list to `<dir>/PaceIT-Backups/`. Strongly recommended; the website cannot protect you from its own disk failing |
| `PACE_BACKUP_KEEP`, `PACE_BACKUP_KEEP_DAILY`, `PACE_BACKUP_KEEP_WEEKS` | 14 (`npm run backup`), 30, 26 | How many daily copies and extra weekly copies are kept |
| `PACE_STARTUP_CHECK_MAX_MB` | `512` | Above this database size the start-up `quick_check` is skipped (the nightly helper checks instead) so a restart is never a long outage |

## Backups

Attached forms are immutable files named by their hash, and the database only holds metadata, so a backup is cheap: the database is copied as one consistent snapshot (`VACUUM INTO`, the website keeps working and is **not** put into maintenance mode) and only the forms the backup does not have yet are copied (each one hash-checked). Every backup is complete for restore purposes; the cost of each is only what is new.

What runs, and where:

- **Every day, automatically** (a separate helper process, so the website never freezes while it copies or checks): a verified snapshot in `data/backups/`; if `PACE_BACKUP_DIR` is set, the same snapshot plus new forms, the secret key and the institute list on that second drive; a health check of the live database (integrity, broken links between records, missing form files); and clean-up of form files nobody needs any more. Retention: the newest 30 daily snapshots plus one per week for 26 weeks.
- **On demand or scheduled**, to a drive you choose:

```bash
npm run backup                 # asks which drive (D, F ...), finds it, copies, verifies
npm run backup -- d            # no questions: back up to drive D
npm run backup -- d --keep 14 --weeks 12   # 14 daily copies + one per week for 12 weeks (defaults)
npm run backup -- D:\PaceBackups  # a folder also works (Task Scheduler / network share)
```

The first copy of a large set of forms takes as long as copying them takes; later ones only copy what is new. The destination must be outside `data/`. The backup stops with a clear message if the drive is full, a copy does not match its hash, or the database snapshot fails its integrity check, and then keeps the older backups.

Scheduling (only needed if you do not use `PACE_BACKUP_DIR`):

- Linux (cron, daily at 02:00): `0 2 * * * cd /path/to/paceit && npm run backup -- /mnt/usb/paceit >> backup.log 2>&1`
- Windows: `schtasks /Create /SC DAILY /ST 02:00 /TN "PaceIT Backup" /TR "cmd /c cd /d C:\path\to\paceit && npm run backup -- D:\PaceBackups"`

**The secret key** (`pace_it_secret.key`) is copied into the backup's `extras/` folder. Without it a restore only signs everyone out, but treat the backup drive as sensitive. After `npm run harden`, old key copies on backup drives are stale; delete `extras/pace_it_secret.key` there.

### Restore

Test this while the data is small. A restore that takes hours is fine; it prints progress and can be re-run.

1. **Stop the website.**
2. `npm run restore` (lists the backups it finds on this computer and on `PACE_BACKUP_DIR` and asks which one), or `npm run restore -- <snapshot file or backup folder>`. Add `--dry-run` to only check a backup, `--deep` to re-hash every form, `--yes` to skip the confirmation, `--allow-missing` to restore even when some forms are not in the backup.
3. It checks the backup, brings back the forms it needs, moves the current database aside to `data/backups/before-restore-<time>/` (nothing is deleted), puts the backup in place, checks the result, and prints `RESTORE OK`.
4. Start the website and open a record with an attached form.

Backups made by earlier versions of the app (attached forms inside the database file) restore the same way; the app moves the forms to files when it starts.

In-app alternative (admin, fine for small data; with many attached forms the file becomes very large and the server will tell you to use `npm run backup` instead): **Data Backup & Restore → Full backup** downloads one `.json` file with the whole database (refused above about 200 MB of attached forms: use `npm run backup`); **Restore from backup file** puts all of it back (and **Wipe the entire database** empties everything except user accounts and the security log).

## Project layout

```
server.ts               Express setup, security headers, cross-site check, HTTPS switch, request limits, static serving
public/theme-init.js    Applies the saved light/dark theme before the page paints
server/api.ts           API routes, authentication, rate limiting, live-update stream
server/db.ts            Schema, migrations and business rules
server/pdfExtractor.ts  UPAC PDF parsing (bijoy.ts decodes legacy Bangla font text)
server/docxFiller.ts    Fills template/EDC Form.docx
server/edcIndex.ts      Loads the EDC institute list
scripts/backup.ts       Backup to a drive you choose
scripts/daily-backup.ts The daily helper process (local snapshot, second-drive mirror, health check)
scripts/restore.ts      Restore a backup
server/blobs.ts         Attached forms as hash-named files
server/backupCore.ts    Snapshot, verify, retention, health check (shared by the scripts)
server/migrations.ts    The numbered database migrations
src/App.tsx             Application shell, data loading, live updates, navigation
src/components/         Screens and dialogs
src/utils/              Helpers: categories, upazilas, dates, exports, CSV import
```

## Documentation

- [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md): architecture, data model, rules and operations
- [docs/API.md](docs/API.md): HTTP endpoint reference

## Stack

React 19, Vite, Tailwind CSS 4, Express 4, Node built-in SQLite, TypeScript.

## Security hardening notes

- **Keep the data outside the project folder.** Set `PACE_DATA_DIR` (for example `D:\PaceItData`) before starting the server and the backup script. Move the existing `data` folder there once. Code copies and zips then never contain the database, secret key or backups.
- **Clean-up after any copy of the folder was shared:** stop the server, then run `npm run harden` (removes leftover database copies when a verified backup covers them, replaces the secret key, signs everyone out, restricts the folder to your Windows account) and `npm run reset-password -- --all` (prints a new random password per account).
- **Backups:** set `PACE_BACKUP_DIR` to a second physical drive and the daily helper mirrors everything there; `npm run backup` (asks for the drive letter; the website stays open) makes a verified copy on demand; `npm run restore` brings a backup back. `powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1 -BackupDir "E:\PaceItBackups"` schedules it daily.
- **Roles:** only administrators can delete connections, foremen and team members.
- **Passwords:** at least 10 characters, not common, not containing the username. Sign-ins end after 12 hours without use.
- **No outside requests:** fonts and photos are served by the app itself (Fustat for English and Kalpurush for Bangla are bundled in `src/fonts`).
- **HTTPS:** put `cert.pem` and `key.pem` in `<data folder>/certs` (or run behind an HTTPS reverse proxy with `COOKIE_SECURE=1`).
