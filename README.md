# OverDrive

Secure file storage and sharing with client-side encryption. Files are
encrypted **in the browser** before a single byte leaves the device — the
server, the database, and blob storage only ever hold ciphertext.

## Stack

- SvelteKit 2 with Svelte 5 (runes) + TypeScript
- Tailwind CSS v4
- Neon Postgres (serverless driver, `drizzle-orm`)
- Vercel (serverless functions, `adapter-vercel`) + Backblaze B2 (S3-compatible ciphertext storage)
- WebCrypto (AES-GCM, RSA-OAEP, ECDH-P256, PBKDF2) + libsodium-wrappers-sumo (ChaCha20-Poly1305, Argon2id)
- Zod (request validation) · Vitest (crypto round-trip tests)

## Encryption model

| Layer | Options | Where |
|---|---|---|
| File content | AES-256-GCM, ChaCha20-Poly1305 | browser, per-chunk (2 MiB) |
| Key wrapping | RSA-OAEP (4096-bit), ECDH (P-256, ECIES-style) | browser |
| Password-based | PBKDF2-SHA256 (600k iter), Argon2id (64 MiB, t=3) | browser, used for share links + private-key wrapping |
| Recovery key | HKDF-SHA256 over 256 random bits → AES-GCM key + server proof token | browser, wraps a 2nd copy of the private key |

Every file gets a fresh random 256-bit symmetric key. That key is wrapped
under the owner's public key (RSA-OAEP or ECDH) before upload — the server
stores only the wrapped (ciphertext) key. Filenames and MIME types are
encrypted into `file_metadata` separately, so the server is
**metadata-blind**, not just content-blind. See inline comments in
`src/lib/server/db/schema.ts` for the full data-model rationale.

Two distinct secrets come from the same login password but are never
interchangeable: the **auth verifier** (`authHash`, a plain Argon2id hash
the server can check) and the **key-wrapping key** (derived independently
in-browser via `crypto/kdf.ts`, never sent to the server). A leaked
`authHash` lets someone log in; it does not let them decrypt anything.

## Security features

- **Rate limiting** — login lockout after 8 failed attempts from one IP in
  15 minutes (`src/lib/server/rate-limit.ts`), backed by the DB rather than
  in-memory state, so it actually works across stateless serverless
  invocations.
- **Input validation** — every API route that accepts client JSON validates
  it against a Zod schema (`src/lib/server/schemas.ts`) before touching the
  database.
- **Security headers** — CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy, and HSTS, applied in production only
  (`src/hooks.server.ts` — gated off in dev so Vite's HMR websocket isn't
  broken by CSP).
- **File size cap** — 500 MB, enforced both client-side (before encryption
  starts) and server-side (defense in depth) — see `src/lib/shared/limits.ts`.
- **Ownership checks everywhere** — every file/share/chunk route verifies
  the requesting user actually owns the resource before acting on it,
  including share-link revocation (a real gap that existed briefly during
  development — a revoke request now must also match the file's owner, not
  just the token).
- **Mandatory integrity verification** — download refuses to proceed if a
  file's ciphertext hash is missing, rather than silently skipping the
  check (this exact gap once let a corrupted upload through undetected).
- **Write-then-read verification on every chunk upload** — the server
  reads back what it just stored and compares it against what the client
  sent, *before* acknowledging the chunk as successful. A same-request
  "the write call didn't throw" check only proves blob storage accepted
  the bytes, not that it durably stored the same bytes — this closes that
  gap immediately, while the original file is still available to retry
  with, instead of only surfacing as a broken download later.
- **Password change** — always re-verifies the current password
  server-side and re-wraps the private key client-side; the server never
  sees a usable private key at any point (`/settings/account`).

## Project layout

```
src/lib/crypto/            client-side encryption primitives (never imported server-side)
  file-encryption.ts        AES-GCM / ChaCha20-Poly1305, chunked
  key-encryption.ts         RSA-OAEP / ECDH-P256 key wrapping
  kdf.ts                    PBKDF2 / Argon2id
  password-wrap.ts          share-link password wrapping
  private-key.ts            wrap/unwrap/re-wrap the private key
  strength.ts                UI strength-indicator scoring
  upload-pipeline.ts         orchestrates encrypt -> chunk -> upload
  download-pipeline.ts       orchestrates fetch -> verify -> decrypt (and raw ciphertext export)
  share-pipeline.ts          password-based share-link wrap/unwrap
  __tests__/                 Vitest round-trip + tamper/wrong-key tests

src/lib/server/             server-only helpers (DB, auth, rate limiting, validation)
src/lib/shared/limits.ts    constants safe to import from both client and server
src/routes/api/files/       upload / list / chunks / share / delete (all ciphertext-only)
src/routes/api/share/       public, unauthenticated share-link endpoints
src/routes/share/[token]/   public share-link landing page (password prompt, no account needed)
src/lib/components/         EncryptUploader, StrengthIndicator, ConfirmModal, ShareModal, AppHeader
```

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET, B2_*
npm run db:push        # push schema to Neon (additive columns/tables; safe on existing data)
npm run b2:cors -- https://your-app.vercel.app http://localhost:5173   # one-time, see "Direct uploads"
npm run dev
npm test               # crypto, upload/download pipelines, and every API route against in-memory Postgres
npm run check          # svelte-check — type errors across the whole app
```

## Deploy to Vercel

1. **Backblaze B2** (storage): sign up at backblaze.com (no card required for private buckets) → create a bucket, set it **Private** → Account → Application Keys → **Add a New Application Key**, scoped to that bucket → gives you `B2_KEY_ID` and `B2_APPLICATION_KEY`. The bucket's details page shows its **Endpoint** (e.g. `s3.us-west-004.backblazeb2.com`) and region code (e.g. `us-west-004`).
2. **Vercel**: import the GitHub repo at vercel.com/new. `vercel.json` + `adapter-vercel` in `svelte.config.js` are already set up — Vercel auto-detects the SvelteKit framework preset.
3. Add env vars in Project Settings → Environment Variables: `DATABASE_URL`, `SESSION_SECRET`, and the five `B2_*` values from step 1. No `ORIGIN`/`ADDRESS_HEADER`/`BODY_SIZE_LIMIT` needed — those were specific to the previous `adapter-node`/Render setup; `adapter-vercel` already knows how to read client IPs and request origin correctly on Vercel's own infrastructure.
4. For local dev, `npm run dev` works as normal — Backblaze B2 needs no platform-specific wrapper, just the same env vars everywhere.
5. Run `npm run b2:cors -- <your origins>` once (see **Direct uploads** below), then push to `main` (or run `vercel --prod`) to deploy.

**Why chunks are 2 MiB, not 4 MiB** (`crypto/types.ts`): Vercel Functions have a hard, non-configurable 4.5MB limit on request and response bodies. Chunk *downloads* (and the upload fallback relay) still pass through a function as base64-in-JSON, which adds ~33% overhead — 4 MiB chunks would encode to ~5.3MB and be rejected with `413: FUNCTION_PAYLOAD_TOO_LARGE`. 2 MiB chunks encode to ~2.7MB, comfortably under the limit. Normal uploads no longer go through a function at all (below).

## Direct uploads (no size cap from Vercel)

Uploads go **browser → Backblaze B2** through presigned PUT URLs; the function only coordinates:

1. `POST /api/files/upload {action:'init'}` — creates the file row with `upload_status = 'uploading'`.
2. `{action:'presign'}` — returns short-lived presigned URLs for batches of up to 32 chunks.
3. The browser encrypts each 2 MiB chunk and PUTs the raw ciphertext to B2 (4 in parallel; memory stays flat).
4. `{action:'finalize'}` — the server lists the bucket, checks every chunk exists and the total size matches what was declared, stores the client's streaming SHA-256 of the whole ciphertext, and flips the row to `complete`. Only then does the file appear in the vault.

The per-file cap is `MAX_FILE_SIZE_BYTES` in `src/lib/shared/limits.ts` (5 GiB; it exists purely as a cost/abuse guard — raise it for a personal vault).

**Resume:** an interrupted upload stays as `uploading` and appears under *Incomplete uploads*. Because chunk encryption is deterministic for a given key and base nonce, re-selecting the same file re-encrypts to byte-identical ciphertext, skips chunks already in B2, and finishes with a correct hash.

**Fallback:** if the first direct PUTs fail (bucket CORS not set yet, a blocked network), the upload automatically switches to the old server relay for the rest of that file, so uploads keep working while you fix CORS.

**One-time setup — bucket CORS.** Browsers need B2 to allow your origins:

```powershell
npm run b2:cors -- https://your-app.vercel.app http://localhost:5173
```

This calls B2's S3-compatible `PutBucketCors` using your `.env`. The application key needs the **writeBuckets** capability for this one command — make a temporary key if yours is read/write only. The CSP (`svelte.config.js`) already allows `https://*.backblazeb2.com` for `connect-src`; narrow it to your exact bucket host if you prefer.

Backblaze B2 buckets are private by default, so ciphertext is only ever readable through your own authenticated routes, never a guessable public link.

## Auth & key flow

- `/register` — generates an RSA-OAEP or ECDH keypair in-browser, derives an Argon2id wrapping key from the chosen password, encrypts the private key with it, and submits `{publicKeyJwk, wrappedPrivateKey, ...}` alongside a normal Argon2id auth-password hash (`@node-rs/argon2`, server-side). Sets an HttpOnly JWT session cookie (`jose`).
- `/login` — rate-limited; verifies the auth password server-side, then the response carries the *wrapped* private key back to the browser, which re-derives the same Argon2id key from the password just typed and unwraps it locally.
- `/settings/account` — change password: requires the current password again (the in-memory key is intentionally non-extractable, so this can't be skipped), re-wraps the private key client-side, and updates both the auth hash and wrapped key server-side in one request. The same page manages the recovery key, two-factor auth, and full export (below).
- `src/lib/stores/key-store.svelte.ts` — holds the unlocked `CryptoKey` objects in memory only, for the current tab. Refreshing the page locks it again by design; `/settings/keys` re-unlocks by re-fetching wrapped material from `/api/auth/keys` and re-deriving the key from a re-entered password.
- `src/hooks.server.ts` — verifies the session cookie on every request, populates `locals.user`, and applies security headers in production.

## Running it for other people

- **Sign-up is invite-only by default** (`REGISTRATION_MODE`). Open **Admin** (shown for emails in `ADMIN_EMAILS`) → create an invite → send the code or the `/register?invite=…` link. Only a SHA-256 of each code is stored, so it's shown once. Codes can be single- or multi-use, expire, carry their own storage limit, and be revoked. Wrong codes count toward the same per-IP lockout as wrong passwords. On an empty database the first sign-up is always allowed so you can create the admin account.
- **Storage limits.** `DEFAULT_QUOTA_GB` per account (admin and per-invite overrides; 0 = unlimited). Everything stored counts: finished files, the trash (until purged) and unfinished uploads. Uploads over the limit are refused at `init`, before any encryption work. It's a soft limit — two uploads started in the same instant can both pass. The Vault and Account pages show the meter.
- **Sessions.** Each sign-in is a row in `sessions`; the cookie's JWT carries its id and every request checks the row, so a device can be signed out immediately (Account → *Devices & sessions*), signing out revokes server-side, changing the password signs out every other device, and account recovery signs out all of them. Cookies issued before this feature carry no session id, so everyone signs in once after upgrading.
- **Daily cleanup** (`/api/cron/cleanup`, scheduled in `vercel.json`, protected by `CRON_SECRET`): purges trash older than 30 days, discards uploads abandoned for 48 h, deletes expired sessions, and sweeps orphaned chunks (stored objects no database row refers to, older than 24 h) — resuming from a saved cursor so a large bucket is covered over several runs. Vercel Hobby allows daily cron jobs, which is exactly this schedule.
- **Admin sees** emails, sizes and sign-in times — never file names, keys or content.

## Recovery, 2FA and export

- **Recovery key.** At sign-up the browser generates 256 random bits and shows them once as a printable kit (52 base32 characters). HKDF derives (a) an AES-GCM key that wraps a *second* copy of the private key and (b) a proof token; the server stores that ciphertext plus only SHA-256 of the proof — never the key. `/recover` fetches the blob (unknown emails get a deterministic same-shaped decoy), opens it with the typed key, re-wraps the **same** private key under a new password, and proves possession with the token. Files stay decryptable; the recovery key stays valid. Existing accounts create one from Account → *Recovery key* (needs the current password). Recovery also turns 2FA off, so a lost phone can't lock you out.
- **TOTP 2FA.** RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), implemented in `server/totp.ts` and tested against the RFC vectors. Secrets are AES-GCM-encrypted at rest with a key derived from `SESSION_SECRET`. With 2FA on, a correct password releases **nothing** (no session cookie, no wrapped key) until the code also verifies; a used step can't be replayed (conditional update, safe under concurrent requests). Wrong codes count toward the same per-IP lockout as wrong passwords. Passkeys aren't implemented.
- **Export.** Account → *Export your vault* decrypts everything in the browser into one `.zip` with your folder structure (`crypto/export-vault.ts` + a streaming ZIP64 writer, `crypto/zip-writer.ts`, since fflate's streaming writer can't produce archives over 4 GiB). Chromium browsers stream straight to disk; others build it in memory. A file that fails integrity checks is listed in `EXPORT-REPORT.txt` rather than aborting the export.

## Folders, search, trash, previews

- **Folders** are rows in `folders`; each has its own random key, wrapped for the owner, and an encrypted `{name, parentId}` blob. A file's folder lives inside its encrypted metadata blob (`folderId`). The server only learns *how many* folders exist.
- **Rename / move** = decrypt the blob in the browser, edit, re-encrypt under the same key, `PATCH` the new ciphertext. The server can't tell a rename from a move.
- **Search** is local: names are decrypted when the vault opens and filtered in memory. Nothing about a query reaches the server.
- **Trash** is a soft delete (`deleted_at`); blobs stay until *Delete forever* (`POST /api/trash`, action `purge`), which removes the B2 objects before the rows. Trashing a folder carries its subtree; there's an *Undo* toast. Trashed files are refused by the chunk and share routes.
- **Previews** (images, PDF, video, audio, small text) decrypt into memory and render from `blob:` URLs, under size caps in `lib/preview.ts`. Text is always shown as plain text, never as markup.

## Download & decrypt

- `GET /api/files` — lists the current user's files: wrapped keys, IVs, and encrypted metadata blobs only, never plaintext.
- `GET /api/files/[id]/chunks/[index]` — streams back one ciphertext chunk from blob storage, ownership-checked.
- `DELETE /api/files/[id]` — moves the file to the trash (soft delete; blobs are kept until it's purged).
- `src/lib/crypto/download-pipeline.ts` — unwraps the file key, then fetches (3 chunks ahead), hash-checks and decrypts chunk by chunk into a *sink*. The running SHA-256 is compared before the sink is committed (hard failure if the hash is missing, not a silent skip); on any failure the sink is aborted so no unverified file is left behind. In-memory `Blob` sink by default; on Chromium, files over 100 MB stream straight to disk via the File System Access API. Also exports `downloadRawCiphertext()`, which bundles the ciphertext plus a decryption manifest into a single `.zip` (via `fflate`), without ever decrypting locally.
- The dashboard decrypts each file's name/size client-side as soon as your key is unlocked. Each row has four actions: download & decrypt, download encrypted (raw `.enc` + manifest), share, delete (behind a real confirmation modal, not `window.confirm`).

## Sharing

- Owner side: `ShareModal.svelte` unwraps the file's real key with the owner's private key, re-wraps it under a share password (Argon2id), and posts the wrapped copy to `POST /api/files/[id]/share`. The server never sees the share password or the underlying file key. Links can have an expiry and/or a max-download count, and are listed/revocable from the same modal.
- Recipient side: `/share/[token]` needs no account. Metadata and content are decrypted locally after the share password unwraps the key. A download reserves one attempt and uses a signed grant for all its chunks.

## Database backups and recovery

`npm run db:backup` captures all vault tables, enums, constraints, indexes and sequences in one read-only, repeatable-read Neon transaction. It compresses and encrypts the snapshot with an independent AES-256-GCM key, writes it to the private B2 bucket under `_database-backups/v1/`, reads it back, checks its SHA-256 and decrypts it to verify the archive. Previous backups are pruned only after a new one has passed verification. The default retention is 30 days (`BACKUP_RETENTION_DAYS`). An encrypted local copy and a non-secret latest-run report are saved in the ignored `.backups/` folder.

The first local run creates `BACKUP_ENCRYPTION_KEY` in `.env` if it is missing. Keep an offline copy of that key and the deployment's `SESSION_SECRET` (used for stored TOTP secrets). File passwords and recovery keys remain separate. The database backup key is never printed, put in an archive, or returned by an API.

- **Windows schedule:** run `./scripts/install-backup-task.ps1`. The `OverDrive Database Backup` task runs every four hours from 03:00 local time, as the signed-in user, with hidden windows and catch-up after wake/sign-in. Each run tries up to three times, and Task Scheduler retries failed runs up to three times at ten-minute intervals. `./scripts/verify-backup-task.ps1` runs the registered task and verifies its report. Diagnostics are in `.backups/task-output.log` and `.backups/task-error.log`. Reinstall the task if the workspace moves.
- **Vercel schedule:** deploy the new routes and `vercel.json`, and set `BACKUP_ENCRYPTION_KEY` and `CRON_SECRET` in the production environment. `/api/cron/backup` runs daily at 02:00 UTC, before the existing cleanup job. Daily schedules work on Hobby; more frequent hosted crons require a plan that supports them. The Vercel job continues when the PC is off.
- **Backup location:** by default, snapshots use the existing private B2 bucket. Optionally set `B2_BACKUP_BUCKET_NAME` to a separate private bucket accessible to the configured application key. Backups consume bucket space outside per-user file quotas.
- **Neon PITR:** Project Settings → Restore window controls Neon's own point-in-time history. A non-zero window enables it; use the largest window your plan allows. The separate Snapshots tab does not list these B2 backups. The database connection cannot change the account's restore-window setting.
- **Status:** Admin → Database backups shows the last successful verified snapshot, failures, retention and whether the hosted schedule has its required secret. Admins can also run a backup there.

Verify the latest local archive by restoring it into a temporary in-memory Postgres database and comparing every table's data:

```powershell
npm run db:verify-backup
```

Recover into a **new, empty** Neon database. Set `DATABASE_RESTORE_URL` in `.env` to the new database URL, keep the backup key available, and supply a local archive or its B2 key:

```powershell
npm run db:restore -- --file .backups/<timestamp>.json.gz.enc
# Or: npm run db:restore -- --from _database-backups/v1/<timestamp>.json.gz.enc
```

The restore command refuses the current `DATABASE_URL` and any non-empty target. It recreates schema and rows, applies the current additive migrations and revokes restored sessions in one transaction. Verify the recovered vault before switching the app's `DATABASE_URL`. `--sql-out <path>` exports the snapshot's decrypted SQL for a manual recovery. Database snapshots contain metadata and wrapped keys; they do not copy B2 file chunks, so permanently purged ciphertext stays gone. The exporter supports this vault's schema up to 64 MiB of uncompressed data; use `pg_dump` for a larger database or one with custom views, partitions or row policies.

## Photos and file versions

Photo uploads generate a raster thumbnail in the browser, up to 384 pixels on its longest edge. The thumbnail and its MIME type are encrypted with a separate HKDF-derived AES-GCM key, stored as an immutable B2 object, and included in storage usage. **Photos** browses images across the vault, filters decrypted names locally and lazily fetches only the encrypted derivatives, with four loads at a time. **Create missing thumbnails** performs a one-time browser backfill for existing photos by verifying/decrypting their originals locally. Unsupported image formats and sources over 50 MiB keep a placeholder. Opening a photo uses the existing full-file preview size limits.

File actions → **Version history** provides **Upload new version**, download and restore. Replacements keep the logical file id, name and folder. They use a fresh key/nonce and a separate pending row; only a fully verified upload can replace current content. The old descriptors, metadata, thumbnail and storage pointer are archived atomically. Revision checks also prevent stale renames, moves and replacements from overwriting a newer encryption key.

Regular uploads accept multiple files from the picker or drag-and-drop and upload them in sequence. They also check locally decrypted filenames in the destination folder. If the full filename (including its extension) already exists, **File already exists** asks for **Cancel** or **Continue** before any upload is created. Continue uploads a new version of the existing file; Cancel skips that file. The check refreshes the listing between files, so duplicate names within one batch also prompt. The same filename in another folder and files with different extensions remain separate.

Dragging external files or folders into the app opens the upload modal. Importing and automatic encryption start after the drop, using the open vault folder or the specific folder/breadcrumb they were dropped onto. The backdrop lets an active external drag reach visible folder targets. Nested and empty directories are preserved with encrypted names/parent pointers; matching existing folders are merged, and matching files use the overwrite confirmation. Additional drops queue behind an active upload. Browsers can supply legacy directory entries or File System handles; directory readers are drained across all batches. Reading failures are reported before any folder or upload is created, and an unlocked key is required. Dragging existing vault items still moves them within the vault.

Both encryption options start unselected. Click a selected method again to clear it. After the drop, the system compares AES-GCM and ChaCha20-Poly1305 on this device using synthetic bytes, warm-up runs and median timings for the workload size, then highlights its choice. Both use 256-bit authenticated encryption. Choices are cached for five minutes. The picker also chooses for you when no method was selected; manual choices remain available. New folder metadata uses the measured choice too. The upload card closes after the complete import is saved and the vault listing is refreshed, including empty-folder imports. A preview card also closes when its external drag leaves, is cancelled, or ends without a drop.

The last five revisions (current plus four previous) are kept. Active share links pin older versions until the links end, including an in-flight download's grant. Versions and thumbnails count toward quota; reusing a stored revision on restore counts its objects once. Restore keeps the current name/folder and archives the content it replaces. Cleanup retries failed version purges, protects retained storage during orphan sweeps, and permanent file deletion removes all of the file's revisions and pending replacements.

Apply the additive migration before serving the updated code on an existing deployment:

```powershell
npm run db:backup
npm run db:migrate
```

Fresh databases can use `npm run db:push`. The migration preserves existing file ids, keys, storage pointers and metadata. The vault displays listing errors and a retry button instead of presenting a failed request as an empty account.

## Managing share links

**Links** in the header lists links grouped by file, with local name search, active/ended filters, copying, creation/expiry dates, download counts and revocation. The per-file share dialog uses the same controls. Names are decrypted in the browser, and link passwords are never stored or returned.

Existing links stay bound to the content key they were created for when a file is replaced or restored. A download reserves one attempt and receives a two-hour signed grant, so using the final allowed download does not block its remaining chunks. Every chunk still checks expiry, trash status and revocation, so revoking a link also stops its in-flight requests.

Reaching a download limit automatically marks the link **Revoked · limit reached**, and blocks new admissions. Already admitted downloads can finish with their existing grants; an owner can stop those immediately. Older exhausted links are also revoked when listed or during cleanup. Scrollbars throughout the app use 4-pixel primary-color thumbs with styled, rounded tracks (Firefox uses its native thin scrollbar). Modal scrollbars are inset 8 pixels, and cards clip overflow so the entire scrollbar stays inside the rounded border.

## Device identity

Sessions use a stable random browser/profile id stored in the HttpOnly `overdrive_device` cookie. Logout keeps this id. Signing in again updates the existing account/device row instead of creating another entry; its token generation increments so old cookies remain invalid after re-authentication or a later sign-in following revocation. A unique database index enforces one row per account/device. Different browsers remain separate even when their user-agent and IP match.

Existing sessions are adopted on their next authenticated request. Opening Devices & sessions retires other untracked sign-ins for that account once while keeping the current browser signed in; those browsers sign in again to receive an identity. Each browser/profile counts as a device. Folder bulk actions wait for encrypted metadata to finish decrypting before collecting hidden descendants.

## Rebranding compatibility

OverDrive keeps existing accounts, encrypted files, thumbnails, recovery keys and two-factor secrets readable without a database migration or re-encryption. Immutable v1 derivation labels live in `src/lib/shared/legacy-protocol.js`. New database archives use the OverDrive header, and the restore tools also authenticate and read older archives. Existing share-download grants remain valid until their original expiry.

On the same origin, valid older cookies are promoted to `overdrive_session` and `overdrive_device` without changing the session token, expiry or device id. Logout clears both session-cookie names. Cookies are scoped to an origin, so a new deployment domain requires a sign-in there; keep the previous domain attached to the same Vercel project for existing bookmarks and share links. Keep the same Neon database, B2 bucket, `SESSION_SECRET` and backup encryption key during the rename. After moving the local workspace to `OverDrive`, reinstall and verify the **OverDrive Database Backup** task from that directory before retiring the old task.

## Testing

`npm test` (no external services needed) runs:

- **Crypto primitives** — AES-GCM / ChaCha20-Poly1305, RSA-OAEP / ECDH wrapping, PBKDF2 / Argon2id, password wrapping. Each suite asserts decryption **fails** with a tampered ciphertext or the wrong key.
- **Pipelines** — upload → download round trips against an in-memory fake of the server + B2, including resume (only missing chunks re-sent), transient-failure retries, the relay fallback, empty files, tamper detection, and full-vault export with folder structure.
- **ZIP64 writer** — read back by `fflate` and, when installed, Python's `zipfile`, with ZIP64 forced on.
- **TOTP** — RFC 6238 / RFC 4226 test vectors, window and replay rules.
- **Every API route** against a real Postgres engine (PGlite, in-process) built from the Drizzle schema, with B2 mocked: registration, login, recovery (incl. lockout and decoys), 2FA lifecycle, the presigned upload protocol, folders, trash/restore/purge, and cross-user isolation.
- **Database recovery** — encrypted archive integrity, schema/data restoration, exact bigint values, cyclic foreign keys, sequences and retention after verified writes.
- **UI smoke tests** (`npm run test:ui`) — file listing failures/retry, selection and bulk actions, folders, thumbnails without original downloads, share controls and modal/sheet behavior.

## Known gaps / possible next steps

- The UI components are type-checked and built in CI-equivalent runs but have no browser-level (Playwright) tests; direct B2 uploads need your real bucket's CORS and have only been exercised against fakes
- No email verification; passkey 2FA isn't implemented (TOTP only)
- Downloads still relay through a function (2 MiB chunks); presigned GETs would remove that too
- Files over 4 GiB open fine in the streaming ZIP64 export, but some older unzip tools handle ZIP64 poorly
- Share links only support password-based access, not per-recipient public-key sharing (though the schema/crypto primitives for that exist and could be added — see `wrapFileKeyRsa`/`wrapFileKeyEcdh` in `key-encryption.ts`)
- CSP uses `'unsafe-inline'` for styles (see comment in `hooks.server.ts`) because several components use inline `style=""` for CSS-variable-driven theming; tightening this to nonces is possible but not done here
