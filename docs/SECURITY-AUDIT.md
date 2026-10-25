# PACE security and reliability audit (working record)

**Review date:** 25 October 2026  
**Scope:** the uploaded source archive, frontend/backend source, migrations, backup/restore utilities, package scripts and project documentation.  
**Evidence note:** this is a source-level audit plus isolated tests described below, not a certification or a live deployment penetration test. The archive had no Git history or pre-existing test suite. Dependency installation was blocked by npm registry DNS failure (`EAI_AGAIN`), so the existing Vite/Express application could not be launched in this environment.

## API authentication and authorization matrix

All paths below are prefixed with `/api`. “Session” means `authMiddleware` verifies the database-backed session cookie on the server. UI visibility is not considered an authorization boundary.

| Method and path | Required access | Object / field policy observed |
|---|---|---|
| `GET /events` | Session | Per-user stream cap; stream is stopped when its session is no longer active. |
| `GET /status` | Session | Reports maintenance state; `Cache-Control: no-store`. |
| `POST /auth/login` | Public | Account + socket-IP + account-total throttles. |
| `GET /auth/me` | Session | Returns public user profile. |
| `PUT /auth/profile` | Session | Updates the caller's own profile through the database allowlist. |
| `POST /auth/logout` | Public / idempotent | Revokes the presented valid session token, if any, and clears its cookie. |
| `POST /auth/logout-all` | Session | Revokes the caller's sessions. |
| `POST /auth/change-password` | Session + current password | Own-account password change; other sessions invalidated. |
| `POST /auth/note-password-changed` | Session | Authenticated client notification route. |
| `GET /users/avatars` | Session | Profile/avatar data only. |
| `GET /users` | Admin | User listing. |
| `POST /users` | Admin | Creates a non-admin user; role is chosen server-side. |
| `POST /users/:id/disable` | Admin | Admin is protected from being disabled; disabling revokes sessions. |
| `POST /admin/users/:id/reset-password` | Admin | Administrative password reset; writes security/activity history. |
| `GET /admin/security-log` | Admin | Bounded security log. |
| `GET /logs` | Session | All non-deleted shared worksite records; ETag/gzip cache. |
| `POST /logs` | Session | Shared record create/upsert; updates of rows in the Bin are now rejected. |
| `PATCH /logs/:id` | Session | Partial patch; database strips identity, creation, deletion and audit fields. Shared-worksite edits are an existing policy. |
| `POST /logs/bulk-fill` | Session | Explicit list of allowed fields, max 5,000 items. |
| `POST /logs/fix-upazila` | Session | Updates target-derived upazilas for selected IDs. |
| `POST /logs/bulk-term` | Session | Bulk term changes. |
| `POST /logs/bulk-foreman` | Session | Assigns selected logs to an active foreman. |
| `POST /logs/batch` | Session | Batch writes use a transaction. |
| `POST /pdf/scan` | Session | File payload is strict-base64 decoded and must contain a PDF signature. |
| `DELETE /logs/:id` | Admin | Soft-delete to Bin (the API reference had incorrectly marked this as any-user). |
| `POST /logs/:id/upac-form` | Session | Attachment file validation and 20 MiB limit. |
| `GET /logs/:id/upac-form` | Session | Downloads an attachment for the shared record. |
| `DELETE /logs/:id/upac-form` | Session | Detaches the attachment from the shared record. |
| `GET /approvals` | Session | Shared approval queue; intended UI can show requests. |
| `POST /approvals/request` | Session | Admin changes apply immediately; non-admin changes queue for review. |
| `POST /approvals/decide` | Admin | Approve/reject pending items only. |
| `DELETE /approvals/:id` | Session | Database checks requester identity or admin role. |
| `POST /logs/clear-all` | Admin + password | Moves records to Bin, with safety protections. |
| `POST /logs/restore` | Admin + password | Restores/imports log records. |
| `GET /backup/full` | Admin | Downloads sensitive full backup; no-store header. |
| `POST /backup/restore` | Admin + password | Validates before taking a safety snapshot / replacing tables. |
| `POST /backup/wipe` | Admin + password + `WIPE` phrase | Destructive operation with pre-wipe safety copy. |
| `GET /settings` | Session | Reads shared public settings. |
| `PUT /settings` | Session | Deliberately any authenticated user per existing docs/UI; accepts only integer `formOverdueDays` 1–364. Confirm whether this shared control should instead be admin-only before changing the business policy. |
| `GET /targets` | Session | Reads target data. |
| `POST /targets/import` | Admin | Target dataset import. |
| `DELETE /targets` | Admin | Clears target dataset. |
| `GET /import-requests` | Session | Non-admin responses are filtered to the requester's items. |
| `POST /import-requests` | Session | Submits an import request for admin approval. |
| `POST /import-requests/:id/decide` | Admin | Approve/reject import request. |
| `DELETE /import-requests/:id` | Session | Database checks owner identity or admin. |
| `GET /foremen` | Session | Shared foreman data. |
| `POST /foremen` | Session | Existing policy allows authenticated create. |
| `PUT /foremen/:id` | Session | `roam` / `roamAreas` are dropped for non-admins; other shared foreman fields remain editable by authenticated users per existing docs. |
| `DELETE /foremen/:id` | Admin | Soft-delete to Bin (API reference had incorrectly marked this as any-user). |
| `GET /team-members` | Session | Shared team data. |
| `POST /team-members` | Session | Existing policy allows authenticated create. |
| `PUT /team-members/:id` | Session | Existing shared-worksite edit policy. |
| `DELETE /team-members/:id` | Admin | Soft delete (API reference had incorrectly marked this as any-user). |
| `GET /bin` | Admin | Deleted items only. |
| `POST /bin/logs/:id/restore` | Admin | Restore a log from Bin. |
| `POST /bin/foremen/:id/restore` | Admin | Restore a foreman from Bin. |
| `DELETE /bin/logs/:id` | Admin | Permanent delete. |
| `DELETE /bin/foremen/:id` | Admin | Permanent delete. |
| `DELETE /bin` | Admin | Empty Bin. |
| `GET /suggestions` | Session | Shared autocomplete data. |
| `POST /suggestions` | **Admin** | Hardened during this audit: previously any session could replace shared autocomplete lists even though the UI exposed this as an admin action. |
| `GET /activity` | Session | Shared user-visible activity feed. |
| `POST /activity` | Session | Restricts action names and attributes the entry to the session user, but callers can still submit user-visible activity lines; see remaining issues. |
| `GET /meta` | Session | Requires auth in code; API docs had incorrectly described it as public. |
| `GET /lookup` | Session | EDC data lookup. |
| `POST /generate` | Session | DOCX form generation; filename is sanitized. |

### Authorization policy decisions preserved

The existing application is a shared-worksite system rather than a row-per-user system. Signed-in users can read and edit shared active log records, create and update foremen and team members, and change the shared overdue-days setting; the audit did not silently impose per-user record ownership rules. The settings control's visibility and API documentation both support current any-session access. Confirm that policy with the product owner if the setting is intended to be administrator-controlled. Only the explicitly guarded administrative operations above are restricted to administrators.

## Confirmed issues repaired in this working copy

1. **Restore could accept a table with an empty/stripped column list.** A backup could pass shape validation and then `DELETE FROM` an entire table with no compatible insert columns. Version 5 exports now validate all current schema columns, required metadata/table counts, active admin, attachment references, attachment sizes and SHA-256 checksums before any snapshot or destructive restore work. Formats 1–4 remain accepted through compatibility validation.
2. **Log writes were not atomic across primary row, extras, attachment metadata and activity.** `saveLog` now wraps the multi-step SQL work in the database transaction helper. Bulk fill, bulk foreman assignment, approval requests and approval decisions have transaction boundaries around their multi-row changes.
3. **Malformed base64 could be silently decoded.** Attachment upload and PDF scan data now go through strict canonical base64 validation.
4. **Polling fallback did not refresh all data categories.** It now reconciles logs, activity, suggestions, foremen, approvals, imports and maintenance state. SSE reconnect performs a full refresh, overlapping refreshes coalesce, callback failures are isolated, and cleanup disposes the coordinator.
5. **A user could mutate a log already soft-deleted into the admin Bin through the documented upsert path.** The upsert now refuses a deleted record; Bin restore remains an admin workflow.
6. **Shared autocomplete replacement lacked server-side admin enforcement.** `POST /suggestions` now uses `adminMiddleware`.
7. **Express 4 async initialization middleware could drop a rejected readiness promise.** The database readiness promise now forwards rejection to `next()`.
8. **The settings endpoint accepted coercions and unrelated fields.** It now accepts only the one documented setting with an actual integer value in range; rapid frontend writes are serialized and save failures are shown rather than silently swallowed.
9. **API reference route labels were inconsistent with server guards** for log/foreman/team-member deletion and `/meta`; documentation is corrected.
10. **Content-addressed attachment storage trusted same-size files.** `writeBlob()` now verifies the existing blob SHA-256 against its content address and repairs same-size corruption with a temporary-file replacement; the regression test reproduces that exact case.
11. **Backup binary wrappers were too broadly accepted.** Version 5 validation now permits wrapped binary payloads only in attachment data, rejects orphaned or checksum-mismatched attachments, and retains a compatibility validation path for legacy backup versions.

## Data model / database review

The migration baseline defines `users`, `logs`, `foremen`, `team_members`, `approvals`, `import_requests`, `suggestions`, `activity`, `sessions`, `security_events`, `settings`, `targets`, and `attachments`, plus indexes on common filtering/join fields. SQL parameter binding is used for values in the reviewed data layer. The schema does not declare foreign keys and the DB connection explicitly leaves `PRAGMA foreign_keys = OFF`; consistency is therefore application-enforced. The restore validator now checks attachment-to-log references, but a future migration should add selective constraints only after inspecting and repairing existing orphaned data. Existing DB migrations are numbered and run transactionally; no destructive migration was added in this audit.

## Verification performed in this environment

- `npm test`: 17 passed, 1 skipped at final test-suite setup; the skipped test is the checked-in real SQLite integration test because `tsx` is missing from the incomplete local install.
- An isolated SQLite smoke test was executed separately by transpiling the database's local TypeScript dependencies into `/tmp` and using a disposable `PACE_DATA_DIR`. It passed atomic log write rollback, malformed backup rejection without row loss, mid-restore SQL failure rollback, version-5 backup round-trip, and soft-deleted-record protection. The temporary database and attachment directory were removed.
- A syntax/transpile diagnostic pass checked 105 TypeScript / TSX source files and reported 0 syntax diagnostics.
- A source/document check confirmed the matrix lists all 67 declared `router.get/post/put/patch/delete` route declarations.
- `git diff --check` passed.
- `npm run lint` could not execute a semantic type check: TypeScript exited with TS2688 because `vite/client` is absent from the incomplete dependency tree. `npm run build` failed because the `vite` executable is missing. `npm ci` was blocked by npm registry DNS/network failure (`EAI_AGAIN`). These are environmental blockers, not passing checks.

## Limits and residual risks

- Login/password-confirmation rate limits are in a process-local `Map`. This deployment's docs prescribe one server per data directory, so the implementation works within that process, but restarts clear limits and a multi-instance deployment needs shared storage. Behind a reverse proxy, socket address may identify the proxy for all users; do not trust `X-Forwarded-For` without an explicit trusted-proxy design.
- `POST /activity` allows authenticated callers to add constrained but user-visible activity feed rows. Decide whether this legacy endpoint should be admin-only or replaced with server-derived activity events; it was not changed without confirming that API contract.
- `GET /logs` returns all active records; no production dataset or query plan was available to justify a pagination change. Large datasets may increase response memory, gzip-cache memory and browser work.
- Full restore accepts up to 450 MB of JSON and current full export can include up to 200 MiB of raw attachment bytes. This is compatible with the existing feature but has a high memory peak because JSON parsing, object representation and attachment buffers coexist. A streaming backup format is future work, not implemented here.
- Full exports now use backup format version 5. This code accepts legacy formats 1–4, but older PACE releases may not understand v5 exports; coordinate deployment/rollback so an older binary is not expected to restore a v5 backup. No database schema migration was added.
- PDF and DOCX parsers were not fuzzed with hostile compressed or structurally complex files. Current application-level parser and request limits were inspected, but CPU/RAM ceilings and real-file compatibility remain unmeasured.
- No deployment secrets, reverse-proxy configuration, live database, scheduled task, production backup set or real attachments were supplied, so operational configuration, actual scheduled-backup success and recovery of a real deployment remain unverified.
