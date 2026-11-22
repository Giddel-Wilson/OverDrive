/**
 * End-to-end tests of the server routes against a REAL Postgres engine
 * (PGlite, in-process) built from the real Drizzle schema, with object
 * storage replaced by an in-memory map. Handlers are called directly with
 * constructed request events, so auth, validation, rate limiting, 2FA,
 * recovery, trash and the upload protocol all run exactly as deployed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

const mem = vi.hoisted(() => ({
	blobs: new Map<string, Uint8Array>(),
	/** Pretend object ages (ms since epoch); anything not listed counts as "just now". */
	times: new Map<string, number>(),
	pageSize: 1000,
	failDeletes: new Set<string>()
}));

// Mutable so tests can switch REGISTRATION_MODE, quotas, etc. (modules read env at call time).
const envMock = vi.hoisted(() => ({
	env: {
		SESSION_SECRET: 'test-session-secret-0123456789abcdef',
		DATABASE_URL: 'x',
		REGISTRATION_MODE: 'open',
		ADMIN_EMAILS: 'admin@example.com',
		CRON_SECRET: 'cron-secret-0123456789abcdef'
	} as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => envMock);
vi.mock('$app/environment', () => ({ dev: true }));

vi.mock('$server/blob-store', async () => {
	const { createHash } = await import('node:crypto');
	return {
		chunkPrefix: (o: string, f: string) => `${o}/${f}/`,
		chunkKey: (o: string, f: string, i: number) => `${o}/${f}/chunk-${i}`,
		contentPrefix: (f: { ownerId: string; id: string; storageKey: string }) => `${f.storageKey || `${f.ownerId}/${f.id}`}/`,
		thumbnailKey: (prefix: string, hash: string) => `${prefix}thumbnail-${hash}`,
		sha256Hex: async (d: Uint8Array) => createHash('sha256').update(d).digest('hex'),
		filesStore: () => ({
			set: async (k: string, data: ArrayBuffer) => void mem.blobs.set(k, new Uint8Array(data)),
			get: async (k: string) => (mem.blobs.has(k) ? mem.blobs.get(k)!.slice().buffer : null),
			delete: async (k: string) => void mem.blobs.delete(k),
			deleteMany: async (keys: string[]) => {
				keys.filter((k) => !mem.failDeletes.has(k)).forEach((k) => mem.blobs.delete(k));
				return { failed: keys.filter((k) => mem.failDeletes.has(k)) };
			},
			list: async (prefix: string) =>
				[...mem.blobs].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })),
			listPage: async (prefix: string, token?: string) => {
				// Like S3: the continuation token means "keys after this one", so deleting
				// objects between pages doesn't make the listing skip any.
				const keys = [...mem.blobs.keys()].filter((k) => k.startsWith(prefix) && (!token || k > token)).sort();
				const slice = keys.slice(0, mem.pageSize);
				return {
					objects: slice.map((key) => ({
						key,
						size: mem.blobs.get(key)!.length,
						lastModified: new Date(mem.times.get(key) ?? Date.now())
					})),
					next: keys.length > mem.pageSize ? slice[slice.length - 1] : undefined
				};
			},
			presignPut: async (k: string) => `https://b2.test/${k}`
		})
	};
});

vi.mock('$server/db', async () => {
	const { PGlite } = await import('@electric-sql/pglite');
	const { drizzle } = await import('drizzle-orm/pglite');
	// drizzle-kit's ESM build trips over vite-node (dynamic require of fs); its CJS build is fine.
	const { createRequire } = await import('node:module');
	const { pushSchema } = createRequire(import.meta.url)('drizzle-kit/api');
	const schema = await import('../db/schema');
	const pg = new PGlite();
	const db = drizzle(pg, { schema });
	const { apply } = await pushSchema(schema, db as never);
	await apply();
	const { PgDialect } = await import('drizzle-orm/pg-core');
	return {
		db, ...schema,
		runTransaction: (statements: import('drizzle-orm').SQL[]) => pg.transaction(async (tx) => {
			const rows = [];
			for (const statement of statements) {
				const query = new PgDialect().sqlToQuery(statement);
				rows.push((await tx.query(query.sql, query.params)).rows);
			}
			return rows;
		})
	};
});

import { db, users, encryptedFiles, fileVersions, fileMetadata, shareLinks, folders, accessLogs, sessions, invites, maintenanceState } from '$server/db';
import { totpAt, base32Decode } from '../totp';
import { generateEcdhKeypair } from '$crypto/key-encryption';
import { wrapPrivateKey, importPrivateJwk, unwrapPrivateKeyJwk } from '$crypto/private-key';
import { DEFAULT_PBKDF2_PARAMS } from '$crypto/kdf';
import {
	generateRecoveryKey,
	wrapPrivateKeyWithRecovery,
	unwrapPrivateKeyWithRecovery
} from '$crypto/recovery';

import { POST as register } from '../../../routes/api/auth/register/+server';
import { POST as login } from '../../../routes/api/auth/login/+server';
import { GET as getKeys } from '../../../routes/api/auth/keys/+server';
import { GET as recoverBlob, POST as recover } from '../../../routes/api/auth/recover/+server';
import { POST as setRecoveryKey } from '../../../routes/api/auth/recovery-key/+server';
import { GET as twoFaState, POST as twoFa } from '../../../routes/api/auth/2fa/+server';
import { POST as upload, GET as uploadStatus, DELETE as uploadAbort, PUT as uploadRelay } from '../../../routes/api/files/upload/+server';
import { GET as listFiles } from '../../../routes/api/files/+server';
import { DELETE as trashOne, PATCH as patchFile } from '../../../routes/api/files/[id]/+server';
import { GET as chunkRoute } from '../../../routes/api/files/[id]/chunks/[index]/+server';
import { GET as listFolders, POST as createFolder } from '../../../routes/api/folders/+server';
import { PATCH as patchFolder } from '../../../routes/api/folders/[id]/+server';
import { POST as trash } from '../../../routes/api/trash/+server';
import { GET as getRegistration } from '../../../routes/api/auth/registration/+server';
import { GET as listInvitesH, POST as createInvite } from '../../../routes/api/admin/invites/+server';
import { DELETE as revokeInvite } from '../../../routes/api/admin/invites/[id]/+server';
import { GET as adminUsers } from '../../../routes/api/admin/users/+server';
import { PATCH as patchUser } from '../../../routes/api/admin/users/[id]/+server';
import { GET as storage } from '../../../routes/api/storage/+server';
import { GET as sessionsList, DELETE as revokeOthers } from '../../../routes/api/auth/sessions/+server';
import { DELETE as revokeOne } from '../../../routes/api/auth/sessions/[id]/+server';
import { POST as logout } from '../../../routes/api/auth/logout/+server';
import { POST as changePassword } from '../../../routes/api/auth/change-password/+server';
import { GET as me } from '../../../routes/api/auth/me/+server';
import { GET as cleanupRoute } from '../../../routes/api/cron/cleanup/+server';
import { handle } from '../../../hooks.server';
import { SignJWT } from 'jose';
import { runCleanup } from '../cleanup';
import { releaseInvite, redeemInvite } from '../invites';
import { GET as versionList } from '../../../routes/api/files/[id]/versions/+server';
import { POST as versionRestore } from '../../../routes/api/files/[id]/versions/[versionId]/+server';
import { GET as versionChunk } from '../../../routes/api/files/[id]/versions/[versionId]/chunks/[index]/+server';
import { GET as thumbnailGet, PUT as thumbnailPut } from '../../../routes/api/files/[id]/thumbnail/+server';
import { GET as fileLinks, POST as shareCreate, DELETE as shareRevoke } from '../../../routes/api/files/[id]/share/+server';
import { GET as allLinks } from '../../../routes/api/shares/+server';
import { GET as publicShare, POST as beginShareDownload } from '../../../routes/api/share/[token]/+server';
import { GET as publicChunk } from '../../../routes/api/share/[token]/chunks/[index]/+server';
import { GET as backupRoute } from '../../../routes/api/cron/backup/+server';
import { GET as adminBackupStatus } from '../../../routes/api/admin/backups/+server';
import { encryptAndUploadFile } from '$crypto/upload-pipeline';
import { downloadAndDecryptFile, unwrapRecordFileKey, decryptRecordMetadata, type EncryptedFileRecord } from '$crypto/download-pipeline';
import { restoreFileVersion } from '$crypto/versions';
import { reencryptFileMeta } from '$crypto/vault';
import { encryptPhotoThumbnail, decryptPhotoThumbnail } from '$crypto/thumbnails';
import { createShareLink, unwrapShareFileKey, shareRecordAsEncryptedFileRecord } from '$crypto/share-pipeline';
import { getUsage } from '../quota';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Handler = (e: never) => Promise<Response> | Response;
interface Result<T = any> { status: number; body: T; cookies: Map<string, string>; bytes?: ArrayBuffer }

async function call(handler: Handler, method: string, path: string, opts: { body?: unknown; user?: { id: string; email: string } | null; ip?: string; params?: Record<string, string>; headers?: Record<string, string>; cookies?: Map<string, string> } = {}): Promise<Result> {
	const cookies = opts.cookies ?? new Map<string, string>();
	const url = new URL(`http://app.test${path}`);
	const event = {
		request: new Request(url, {
			method,
			headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		url,
		params: opts.params ?? {},
		locals: { user: opts.user ?? null },
		cookies: {
			set: (n: string, v: string) => void cookies.set(n, v),
			get: (n: string) => cookies.get(n),
			delete: (n: string) => void cookies.delete(n)
		},
		getClientAddress: () => opts.ip ?? '10.0.0.1'
	};
	try {
		const res = await handler(event as never);
		if (res.headers.get('content-type') === 'application/octet-stream') return { status: res.status, body: null, bytes: await res.arrayBuffer(), cookies };
		return { status: res.status, body: await res.json().catch(() => null), cookies };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: { message: e.body.message }, cookies };
		throw e;
	}
}

let ipCounter = 0;
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function buildRegistration(email: string, password: string, inviteCode?: string) {
	const kp = await generateEcdhKeypair();
	const wrapped = await wrapPrivateKey(kp.privateKey, password, DEFAULT_PBKDF2_PARAMS);
	const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
	const recoveryKey = generateRecoveryKey();
	const rec = await wrapPrivateKeyWithRecovery(jwk, recoveryKey);
	const body = {
		email,
		displayName: 'Tester',
		password,
		publicKeyJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
		keyAlgo: 'ECDH-P256',
		...wrapped,
		...rec,
		...(inviteCode ? { inviteCode } : {})
	};
	return { body, kp, jwk, recoveryKey };
}

/** Registers via the real handler and returns the raw response (for invite / mode tests). */
async function registerRaw(email: string, inviteCode?: string, ip = freshIp(), password = 'correct horse battery') {
	const { body } = await buildRegistration(email, password, inviteCode);
	return call(register as Handler, 'POST', '/api/auth/register', { body, ip });
}

async function signup(email: string, password = 'correct horse battery') {
	const { body, kp, jwk, recoveryKey } = await buildRegistration(email, password);
	const res = await call(register as Handler, 'POST', '/api/auth/register', { body });
	expect(res.status).toBe(200);
	const [row] = await db.select().from(users).where(eq(users.email, email));
	return { user: { id: row.id, email }, password, recoveryKey, jwk, kp, cookies: res.cookies };
}

const doLogin = (email: string, password: string, extra: Record<string, unknown> = {}, ip = freshIp()) =>
	call(login as Handler, 'POST', '/api/auth/login', { body: { email, password, ...extra }, ip });

// ---------------------------------------------------------------------------
// Runs FIRST on purpose: it needs a deployment with no users yet.
describe('first account on an empty server', () => {
	it('can sign up even when the server is invite-only, and becomes the admin', async () => {
		envMock.env.REGISTRATION_MODE = 'invite';
		try {
			expect((await call(getRegistration as Handler, 'GET', '/api/auth/registration')).body).toEqual({ mode: 'open', bootstrap: true });
			const res = await registerRaw('admin@example.com'); // no invite code
			expect(res.status).toBe(200);
			expect((await call(getRegistration as Handler, 'GET', '/api/auth/registration')).body).toEqual({ mode: 'invite', bootstrap: false });
			// from now on, no code = refused
			expect((await registerRaw('second@example.com')).status).toBe(403);
		} finally {
			envMock.env.REGISTRATION_MODE = 'open';
		}
	});
});

// ---------------------------------------------------------------------------
describe('registration + login', () => {
	it('stores only a hash of the proof token, never the recovery key', async () => {
		const a = await signup('reg@example.com');
		const [row] = await db.select().from(users).where(eq(users.id, a.user.id));
		expect(row.recoveryAuthHash).toMatch(/^[0-9a-f]{64}$/);
		expect(row.recoveryWrappedPrivateKey).toBeTruthy();
		expect(JSON.stringify(row)).not.toContain('"d":');
		expect(row.totpEnabled).toBe(false);
	});

	it('logs in with the right password and rejects a wrong one', async () => {
		await signup('login@example.com', 'a long enough password');
		const ok = await doLogin('login@example.com', 'a long enough password');
		expect(ok.status).toBe(200);
		expect(ok.body.wrappedPrivateKey).toBeTruthy();
		expect(ok.cookies.has('e2e_session')).toBe(true);
		expect(ok.cookies.has('e2e_device')).toBe(true);
		expect((await doLogin('login@example.com', 'wrong password!!')).status).toBe(401);
		expect((await doLogin('nobody@example.com', 'whatever password')).status).toBe(401);
	});

	it('GET /keys reports booleans, never recovery or 2FA secrets', async () => {
		const a = await signup('keys@example.com');
		const res = await call(getKeys as Handler, 'GET', '/api/auth/keys', { user: a.user });
		expect(res.body.hasRecoveryKey).toBe(true);
		expect(res.body.totpEnabled).toBe(false);
		expect(JSON.stringify(res.body)).not.toMatch(/recoveryAuthHash|totpSecret/);
	});
});

describe('account recovery', () => {
	it('recovers an account after the password is lost — same private key, new password, 2FA cleared', async () => {
		const a = await signup('recover@example.com', 'the original password');

		// Step 1: fetch the blob, open it with the recovery key.
		const blobRes = await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=recover@example.com');
		expect(blobRes.status).toBe(200);
		const { privateKeyJwk, authToken } = await unwrapPrivateKeyWithRecovery(blobRes.body.recoveryWrappedPrivateKey, blobRes.body.recoveryIv, a.recoveryKey);
		expect(privateKeyJwk.d).toBe(a.jwk.d);

		// Step 2: re-wrap under a new password, prove possession, reset.
		const newPw = 'a completely new password';
		const wrapped = await wrapPrivateKey(await importPrivateJwk(privateKeyJwk, 'ECDH-P256', true), newPw, DEFAULT_PBKDF2_PARAMS);
		const ip = freshIp();
		const res = await call(recover as Handler, 'POST', '/api/auth/recover', { body: { email: 'recover@example.com', recoveryAuthToken: authToken, newPassword: newPw, ...wrapped }, ip });
		expect(res.status).toBe(200);

		// Old password dead, new one works, and unlocks the IDENTICAL private key.
		expect((await doLogin('recover@example.com', 'the original password')).status).toBe(401);
		const again = await doLogin('recover@example.com', newPw);
		expect(again.status).toBe(200);
		const reopened = await unwrapPrivateKeyJwk(again.body.wrappedPrivateKey, again.body.wrappedPrivateKeyIv, newPw, again.body.privateKeyKdfParams);
		expect(reopened.d).toBe(a.jwk.d);

		// The recovery key still works afterwards (private key unchanged).
		const second = await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=recover@example.com');
		await expect(unwrapPrivateKeyWithRecovery(second.body.recoveryWrappedPrivateKey, second.body.recoveryIv, a.recoveryKey)).resolves.toBeTruthy();
	});

	it('rejects a wrong proof token, and locks out after repeated failures', async () => {
		const a = await signup('recover-bad@example.com');
		const ip = freshIp();
		const bad = { email: 'recover-bad@example.com', recoveryAuthToken: 'f'.repeat(64), newPassword: 'attackers new password', wrappedPrivateKey: 'AAAA', wrappedPrivateKeyIv: 'AAAA', privateKeyKdf: 'PBKDF2', privateKeyKdfParams: {} };
		for (let i = 0; i < 8; i++) expect((await call(recover as Handler, 'POST', '/api/auth/recover', { body: bad, ip })).status).toBe(401);
		expect((await call(recover as Handler, 'POST', '/api/auth/recover', { body: bad, ip })).status).toBe(429);
		// …and the real owner's password is untouched.
		expect((await doLogin('recover-bad@example.com', a.password)).status).toBe(200);
	});

	it('returns a stable, same-shaped decoy for unknown emails (no account enumeration)', async () => {
		await signup('real@example.com');
		const u1 = await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=ghost@example.com');
		const u2 = await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=ghost@example.com');
		const real = await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=real@example.com');
		expect(u1.status).toBe(200);
		expect(u1.body).toEqual(u2.body);
		expect(Object.keys(u1.body).sort()).toEqual(Object.keys(real.body).sort());
	});

	it('creating a replacement recovery key needs the password and invalidates the old key', async () => {
		const a = await signup('replace@example.com', 'my current password');
		const newKey = generateRecoveryKey();
		const w = await wrapPrivateKeyWithRecovery(a.jwk, newKey);

		const wrong = await call(setRecoveryKey as Handler, 'POST', '/api/auth/recovery-key', { user: a.user, ip: freshIp(), body: { currentPassword: 'nope nope nope!', ...w } });
		expect(wrong.status).toBe(401);

		const ok = await call(setRecoveryKey as Handler, 'POST', '/api/auth/recovery-key', { user: a.user, ip: freshIp(), body: { currentPassword: a.password, ...w } });
		expect(ok.status).toBe(200);

		const oldProof = (await unwrapPrivateKeyWithRecovery(
			(await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=replace@example.com')).body.recoveryWrappedPrivateKey,
			(await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=replace@example.com')).body.recoveryIv,
			newKey
		)).authToken;
		const wrapped = await wrapPrivateKey(await importPrivateJwk(a.jwk, 'ECDH-P256', true), 'whatever new password', DEFAULT_PBKDF2_PARAMS);
		const body = (token: string) => ({ email: 'replace@example.com', recoveryAuthToken: token, newPassword: 'whatever new password', ...wrapped });
		// The OLD recovery key's proof no longer works…
		const { recoveryAuthToken: oldKeyToken } = await wrapPrivateKeyWithRecovery(a.jwk, a.recoveryKey);
		expect((await call(recover as Handler, 'POST', '/api/auth/recover', { body: body(oldKeyToken), ip: freshIp() })).status).toBe(401);
		// …the new one does.
		expect((await call(recover as Handler, 'POST', '/api/auth/recover', { body: body(oldProof), ip: freshIp() })).status).toBe(200);
	});
});

describe('TOTP two-factor', () => {
	it('full lifecycle: setup → enable → login needs a code → replay blocked → disable', async () => {
		const a = await signup('2fa@example.com', 'two factor password');
		const me = { user: a.user };

		// setup (not active yet — login unaffected)
		const setup = await call(twoFa as Handler, 'POST', '/api/auth/2fa', { ...me, body: { action: 'setup' } });
		expect(setup.status).toBe(200);
		expect(setup.body.otpauthUri).toContain('otpauth://totp/');
		const secret: string = setup.body.secret;
		expect(base32Decode(secret).length).toBe(20);
		const [stored] = await db.select().from(users).where(eq(users.id, a.user.id));
		expect(stored.totpSecretEnc).not.toContain(secret); // encrypted at rest
		expect((await doLogin('2fa@example.com', a.password)).status).toBe(200);

		// enable needs a valid code
		expect((await call(twoFa as Handler, 'POST', '/api/auth/2fa', { ...me, body: { action: 'enable', code: '000000' } })).status).toBe(400);
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const t0 = Date.now();
			const en = await call(twoFa as Handler, 'POST', '/api/auth/2fa', { ...me, body: { action: 'enable', code: totpAt(secret, t0) } });
			expect(en.status).toBe(200);
			expect((await call(twoFaState as Handler, 'GET', '/api/auth/2fa', me)).body.enabled).toBe(true);

			// 2FA on: password alone releases NOTHING (no key material, no session cookie)
			const stage1 = await doLogin('2fa@example.com', a.password);
			expect(stage1.status).toBe(200);
			expect(stage1.body).toEqual({ twoFactorRequired: true });
			expect(stage1.cookies.size).toBe(0);

			// wrong code
			expect((await doLogin('2fa@example.com', a.password, { totp: '123456' })).status).toBe(401);

			// the code used to ENABLE is a replay → rejected; a later step's code works
			expect((await doLogin('2fa@example.com', a.password, { totp: totpAt(secret, t0) })).status).toBe(401);
			vi.setSystemTime(t0 + 90_000);
			const code = totpAt(secret, Date.now());
			const good = await doLogin('2fa@example.com', a.password, { totp: code });
			expect(good.status).toBe(200);
			expect(good.body.wrappedPrivateKey).toBeTruthy();
			expect(good.cookies.has('e2e_session')).toBe(true);

			// same code again = replay
			expect((await doLogin('2fa@example.com', a.password, { totp: code })).status).toBe(401);

			// disable requires BOTH factors
			vi.setSystemTime(t0 + 180_000);
			const next = totpAt(secret, Date.now());
			expect((await call(twoFa as Handler, 'POST', '/api/auth/2fa', { ...me, ip: freshIp(), body: { action: 'disable', password: 'wrong password!', code: next } })).status).toBe(401);
			expect((await call(twoFa as Handler, 'POST', '/api/auth/2fa', { ...me, ip: freshIp(), body: { action: 'disable', password: a.password, code: next } })).status).toBe(200);
			expect((await doLogin('2fa@example.com', a.password)).body.wrappedPrivateKey).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it('recovery turns 2FA off (lost phone does not lock you out)', async () => {
		const a = await signup('2fa-recover@example.com', 'two factor password');
		const setup = await call(twoFa as Handler, 'POST', '/api/auth/2fa', { user: a.user, body: { action: 'setup' } });
		await call(twoFa as Handler, 'POST', '/api/auth/2fa', { user: a.user, body: { action: 'enable', code: totpAt(setup.body.secret, Date.now()) } });
		expect((await doLogin('2fa-recover@example.com', a.password)).body).toEqual({ twoFactorRequired: true });

		const blob = (await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=2fa-recover@example.com')).body;
		const { privateKeyJwk, authToken } = await unwrapPrivateKeyWithRecovery(blob.recoveryWrappedPrivateKey, blob.recoveryIv, a.recoveryKey);
		const wrapped = await wrapPrivateKey(await importPrivateJwk(privateKeyJwk, 'ECDH-P256', true), 'brand new password!', DEFAULT_PBKDF2_PARAMS);
		expect((await call(recover as Handler, 'POST', '/api/auth/recover', { ip: freshIp(), body: { email: '2fa-recover@example.com', recoveryAuthToken: authToken, newPassword: 'brand new password!', ...wrapped } })).status).toBe(200);

		const after = await doLogin('2fa-recover@example.com', 'brand new password!');
		expect(after.body.wrappedPrivateKey).toBeTruthy(); // straight in, no code
	});
});

// ---------------------------------------------------------------------------
const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');
const initBody = (totalChunks: number, size: number) => ({
	action: 'init',
	fileAlgo: 'AES-GCM',
	keyAlgo: 'ECDH-P256',
	fileIv: b64(12),
	wrappedFileKey: b64(48),
	wrapIv: b64(12),
	ephemeralPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
	metadata: { encryptedBlob: b64(40), iv: b64(12), algo: 'AES-GCM', strengthScore: 70, strengthLabel: 'good' },
	totalChunks,
	chunkSizeBytes: 2 * 1024 * 1024,
	ciphertextSizeBytesEstimate: size + totalChunks * 16
});

describe('presigned upload protocol', () => {
	it('init → presign → (direct PUT) → status → finalize, with verification', async () => {
		const a = await signup('up@example.com');
		const u = { user: a.user };
		const init = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(3, 5000) });
		expect(init.status).toBe(200);
		const fileId: string = init.body.fileId;

		// Pending: invisible in the normal list, visible as "pending".
		expect((await call(listFiles as Handler, 'GET', '/api/files', u)).body.files.map((f: any) => f.id)).not.toContain(fileId);
		expect((await call(listFiles as Handler, 'GET', '/api/files?view=pending', u)).body.files.map((f: any) => f.id)).toContain(fileId);

		// presign: URLs for owned, in-range chunks only
		const ps = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'presign', fileId, indexes: [0, 1, 2] } });
		expect(Object.keys(ps.body.urls)).toEqual(['0', '1', '2']);
		expect(ps.body.urls[1]).toBe(`https://b2.test/${a.user.id}/${fileId}/chunk-1`);
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'presign', fileId, indexes: [3] } })).status).toBe(400);
		const other = await signup('up-other@example.com');
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: other.user, body: { action: 'presign', fileId, indexes: [0] } })).status).toBe(404);

		// Simulate the browser's direct PUTs for chunks 0 and 1 only.
		const put = (i: number, n: number) => mem.blobs.set(`${a.user.id}/${fileId}/chunk-${i}`, new Uint8Array(n));
		put(0, 2000); put(1, 2000);

		const st = await call(uploadStatus as Handler, 'GET', `/api/files/upload?fileId=${fileId}`, u);
		expect(st.body).toMatchObject({ status: 'uploading', totalChunks: 3, uploaded: [0, 1] });

		// finalize refuses while a chunk is missing…
		const sha = 'a'.repeat(64);
		const missing = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'finalize', fileId, ciphertextSha256: sha } });
		expect(missing.status).toBe(409);
		expect(missing.body.missing).toEqual([2]);

		// …and when sizes don't add up (declared 5000 + 48 tag bytes)
		put(2, 10);
		const sizeBad = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'finalize', fileId, ciphertextSha256: sha } });
		expect(sizeBad.status).toBe(409);

		put(2, 1048); // 2000 + 2000 + 1048 = 5048 = 5000 + 3×16
		const fin = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'finalize', fileId, ciphertextSha256: sha } });
		expect(fin.status).toBe(200);
		// idempotent
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'finalize', fileId, ciphertextSha256: sha } })).status).toBe(200);

		const list = await call(listFiles as Handler, 'GET', '/api/files', u);
		const rec = list.body.files.find((f: any) => f.id === fileId);
		expect(rec).toMatchObject({ uploadStatus: 'complete', ciphertextSha256: sha, totalChunks: 3 });
		expect(rec.metadata.encryptedBlob).toBeTruthy();
		const [log] = await db.select().from(accessLogs).where(and(eq(accessLogs.fileId, fileId), eq(accessLogs.action, 'UPLOAD')));
		expect(log.success).toBe(true);
	});

	it('rejects oversize declarations server-side', async () => {
		const a = await signup('big@example.com');
		const res = await call(upload as Handler, 'POST', '/api/files/upload', { user: a.user, body: initBody(10, 6 * 1024 * 1024 * 1024) });
		expect(res.status).toBe(413);
	});

	it('abort deletes the row and every stored chunk; finished files cannot be aborted', async () => {
		const a = await signup('abort@example.com');
		const u = { user: a.user };
		const { body } = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(2, 100) });
		mem.blobs.set(`${a.user.id}/${body.fileId}/chunk-0`, new Uint8Array(10));
		expect((await call(uploadAbort as Handler, 'DELETE', `/api/files/upload?fileId=${body.fileId}`, u)).status).toBe(200);
		expect([...mem.blobs.keys()].some((k) => k.includes(body.fileId))).toBe(false);
		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, body.fileId))).toHaveLength(0);
	});

	it('relay fallback stores chunks with read-back verification', async () => {
		const a = await signup('relay@example.com');
		const u = { user: a.user };
		const { body } = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(1, 3) });
		const res = await call(uploadRelay as Handler, 'PUT', '/api/files/upload', { ...u, headers: { 'X-File-Id': body.fileId, 'X-Chunk-Index': '0' }, body: { chunk: Buffer.from('abc').toString('base64') } });
		expect(res.status).toBe(200);
		expect(mem.blobs.get(`${a.user.id}/${body.fileId}/chunk-0`)).toEqual(new Uint8Array(Buffer.from('abc')));
	});
});

describe('folders, rename/move metadata, trash', () => {
	async function finishedFile(a: Awaited<ReturnType<typeof signup>>) {
		const u = { user: a.user };
		const { body } = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(1, 10) });
		mem.blobs.set(`${a.user.id}/${body.fileId}/chunk-0`, new Uint8Array(26));
		const fin = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: { action: 'finalize', fileId: body.fileId, ciphertextSha256: 'b'.repeat(64) } });
		expect(fin.status).toBe(200);
		return body.fileId as string;
	}

	it('folders: create, list, rename/move (blob replaced), isolation between users', async () => {
		const a = await signup('folders@example.com');
		const b = await signup('folders-other@example.com');
		const payload = { encryptedBlob: b64(30), iv: b64(12), algo: 'AES-GCM', wrappedKey: b64(48), keyAlgo: 'ECDH-P256', keyWrapIv: b64(12), keyWrapEphemeralPublicKeyJwk: { kty: 'EC' } };
		const created = await call(createFolder as Handler, 'POST', '/api/folders', { user: a.user, body: payload });
		expect(created.status).toBe(200);
		expect((await call(listFolders as Handler, 'GET', '/api/folders', { user: a.user })).body.folders).toHaveLength(1);
		expect((await call(listFolders as Handler, 'GET', '/api/folders', { user: b.user })).body.folders).toHaveLength(0);

		const patch = { encryptedBlob: b64(31), iv: b64(12) };
		expect((await call(patchFolder as Handler, 'PATCH', `/api/folders/${created.body.id}`, { user: b.user, params: { id: created.body.id }, body: patch })).status).toBe(404);
		expect((await call(patchFolder as Handler, 'PATCH', `/api/folders/${created.body.id}`, { user: a.user, params: { id: created.body.id }, body: patch })).status).toBe(200);
		const [row] = await db.select().from(folders).where(eq(folders.id, created.body.id));
		expect(row.encryptedBlob).toBe(patch.encryptedBlob);
	});

	it('file metadata PATCH replaces only the encrypted blob, only for the owner', async () => {
		const a = await signup('meta@example.com');
		const b = await signup('meta-other@example.com');
		const id = await finishedFile(a);
		const patch = { encryptedBlob: b64(99), iv: b64(12) };
		expect((await call(patchFile as Handler, 'PATCH', `/api/files/${id}`, { user: b.user, params: { id }, body: patch })).status).toBe(404);
		expect((await call(patchFile as Handler, 'PATCH', `/api/files/${id}`, { user: a.user, params: { id }, body: patch })).status).toBe(200);
		const [m] = await db.select().from(fileMetadata).where(eq(fileMetadata.fileId, id));
		expect(m.encryptedBlob).toBe(patch.encryptedBlob);
	});

	it('trash keeps blobs and is restorable; chunks are blocked while trashed; purge removes everything', async () => {
		const a = await signup('trash@example.com');
		const u = { user: a.user };
		const id = await finishedFile(a);
		const key = `${a.user.id}/${id}/chunk-0`;

		// single-file DELETE = move to trash (soft)
		expect((await call(trashOne as Handler, 'DELETE', `/api/files/${id}`, { ...u, params: { id } })).status).toBe(200);
		expect(mem.blobs.has(key)).toBe(true);
		expect((await call(listFiles as Handler, 'GET', '/api/files', u)).body.files.map((f: any) => f.id)).not.toContain(id);
		expect((await call(listFiles as Handler, 'GET', '/api/files?view=trash', u)).body.files.map((f: any) => f.id)).toContain(id);
		expect((await call(chunkRoute as Handler, 'GET', `/api/files/${id}/chunks/0`, { ...u, params: { id, index: '0' } })).status).toBe(404);

		// restore
		const restored = await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'restore', fileIds: [id], folderIds: [] } });
		expect(restored.body.files).toBe(1);
		expect((await call(listFiles as Handler, 'GET', '/api/files', u)).body.files.map((f: any) => f.id)).toContain(id);

		// can't purge a LIVE file
		const live = await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'purge', fileIds: [id], folderIds: [] } });
		expect(live.body.files).toBe(0);
		expect(mem.blobs.has(key)).toBe(true);

		// trash then purge: blobs and rows gone
		await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'trash', fileIds: [id], folderIds: [] } });
		const purged = await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'purge', fileIds: [id], folderIds: [] } });
		expect(purged.body).toMatchObject({ ok: true, files: 1 });
		expect(mem.blobs.has(key)).toBe(false);
		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, id))).toHaveLength(0);
	});

	it("one user can't trash or purge another user's files", async () => {
		const a = await signup('own-a@example.com');
		const b = await signup('own-b@example.com');
		const id = await finishedFile(a);
		const t = await call(trash as Handler, 'POST', '/api/trash', { user: b.user, body: { action: 'trash', fileIds: [id], folderIds: [] } });
		expect(t.body.files).toBe(0);
		const [row] = await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, id));
		expect(row.deletedAt).toBeNull();
	});

	it('unauthenticated requests are rejected everywhere new', async () => {
		for (const [h, m, p] of [
			[listFolders, 'GET', '/api/folders'],
			[createFolder, 'POST', '/api/folders'],
			[trash, 'POST', '/api/trash'],
			[twoFa, 'POST', '/api/auth/2fa'],
			[setRecoveryKey, 'POST', '/api/auth/recovery-key'],
			[upload, 'POST', '/api/files/upload']
		] as const) {
			expect((await call(h as Handler, m, p, { body: m === 'GET' ? undefined : {} })).status).toBe(401);
		}
	});
});


// ---------------------------------------------------------------------------
// shared helpers for the sections below
// ---------------------------------------------------------------------------
type Authed = { id: string; email: string; sessionId: string };

/** Pushes a login/register response's cookie through the REAL request hook, as the next request would. */
async function sessionOf(res: Result): Promise<{ token: string | undefined; user: Authed | null }> {
	const token = res.cookies.get('e2e_session');
	const jar = new Map(res.cookies);
	const event: any = { cookies: { get: (n: string) => jar.get(n), set: (n: string, v: string) => { jar.set(n, v); } }, locals: {} };
	await handle({ event, resolve: async () => new Response('ok') } as never);
	return { token, user: event.locals.user };
}

async function hookUser(token: string | undefined, deviceId?: string) {
	const jar = new Map<string, string>();
	if (token) jar.set('e2e_session', token);
	if (deviceId) jar.set('e2e_device', deviceId);
	const event: any = { cookies: { get: (n: string) => jar.get(n), set: (n: string, v: string) => { jar.set(n, v); } }, locals: {} };
	await handle({ event, resolve: async () => new Response('ok') } as never);
	return event.locals.user as Authed | null;
}

async function adminUser() {
	const [row] = await db.select().from(users).where(eq(users.email, 'admin@example.com'));
	return { id: row.id, email: row.email };
}

/** A finished upload of `size` plaintext bytes (one chunk). */
async function finishedFileOfSize(a: { user: { id: string; email: string } }, size: number) {
	const { body } = await call(upload as Handler, 'POST', '/api/files/upload', { user: a.user, body: initBody(1, size) });
	mem.blobs.set(`${a.user.id}/${body.fileId}/chunk-0`, new Uint8Array(size + 16));
	const fin = await call(upload as Handler, 'POST', '/api/files/upload', { user: a.user, body: { action: 'finalize', fileId: body.fileId, ciphertextSha256: 'c'.repeat(64) } });
	expect(fin.status).toBe(200);
	return body.fileId as string;
}

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
describe('invite-only sign-up', () => {
	beforeAll(() => void (envMock.env.REGISTRATION_MODE = 'invite'));
	afterAll(() => void (envMock.env.REGISTRATION_MODE = 'open'));

	const newInvite = async (extra: Record<string, unknown> = {}) => {
		const res = await call(createInvite as Handler, 'POST', '/api/admin/invites', { user: await adminUser(), body: extra });
		expect(res.status).toBe(200);
		return res.body as { id: string; code: string };
	};

	it('only admins can manage invites; the code is shown once and only its hash is stored', async () => {
		const plain = await (async () => {
			envMock.env.REGISTRATION_MODE = 'open';
			try { return await signup('plain@example.com'); } finally { envMock.env.REGISTRATION_MODE = 'invite'; }
		})();
		expect((await call(createInvite as Handler, 'POST', '/api/admin/invites', { user: plain.user, body: {} })).status).toBe(403);
		expect((await call(createInvite as Handler, 'POST', '/api/admin/invites', { body: {} })).status).toBe(401);
		expect((await call(listInvitesH as Handler, 'GET', '/api/admin/invites', { user: plain.user })).status).toBe(403);

		const { id, code } = await newInvite({ note: 'for mum' });
		expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
		const [row] = await db.select().from(invites).where(eq(invites.id, id));
		expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(row)).not.toContain(code);

		const list = await call(listInvitesH as Handler, 'GET', '/api/admin/invites', { user: await adminUser() });
		expect(JSON.stringify(list.body)).not.toContain(code);
		expect(list.body.invites.find((i: any) => i.id === id)).toMatchObject({ note: 'for mum', uses: 0, maxUses: 1, createdByEmail: 'admin@example.com' });

		expect((await call(me as Handler, 'GET', '/api/auth/me', { user: await adminUser() })).body.isAdmin).toBe(true);
		expect((await call(me as Handler, 'GET', '/api/auth/me', { user: plain.user })).body.isAdmin).toBe(false);
	});

	it('requires a valid code, and a code works exactly once', async () => {
		const { code } = await newInvite();
		expect((await registerRaw('inv1@example.com')).body.message).toMatch(/invite code is required/);
		expect((await registerRaw('inv1@example.com', 'AAAA-AAAA-AAAA-AAAA')).status).toBe(403);
		expect((await registerRaw('inv1@example.com', code)).status).toBe(200);
		expect((await registerRaw('inv2@example.com', code)).status).toBe(403); // single use, already spent
	});

	it('accepts sloppy typing (lowercase, no dashes, spaces)', async () => {
		const { code } = await newInvite();
		expect((await registerRaw('sloppy@example.com', code.toLowerCase().replace(/-/g, ' '))).status).toBe(200);
	});

	it("a taken email doesn't burn the invite", async () => {
		const first = await newInvite();
		expect((await registerRaw('taken@example.com', first.code)).status).toBe(200);
		const spare = await newInvite();
		expect((await registerRaw('taken@example.com', spare.code)).status).toBe(409);
		expect((await registerRaw('not-taken@example.com', spare.code)).status).toBe(200); // still valid
	});

	it('honours maxUses, expiry and revocation', async () => {
		const multi = await newInvite({ maxUses: 2 });
		expect((await registerRaw('m1@example.com', multi.code)).status).toBe(200);
		expect((await registerRaw('m2@example.com', multi.code)).status).toBe(200);
		expect((await registerRaw('m3@example.com', multi.code)).status).toBe(403);

		const expiring = await newInvite({ expiresInDays: 7 });
		await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expiring.id));
		expect((await registerRaw('late@example.com', expiring.code)).status).toBe(403);

		const revoked = await newInvite();
		const del = await call(revokeInvite as Handler, 'DELETE', `/api/admin/invites/${revoked.id}`, { user: await adminUser(), params: { id: revoked.id } });
		expect(del.status).toBe(200);
		expect((await registerRaw('revoked@example.com', revoked.code)).status).toBe(403);
		expect((await call(revokeInvite as Handler, 'DELETE', `/api/admin/invites/${revoked.id}`, { user: await adminUser(), params: { id: revoked.id } })).status).toBe(404);
	});

	it('an invite can set the new account\'s storage quota', async () => {
		const { id, code } = await newInvite({ quotaGb: 1 });
		expect((await registerRaw('quota-inv@example.com', code)).status).toBe(200);
		const [u] = await db.select().from(users).where(eq(users.email, 'quota-inv@example.com'));
		expect(u.storageQuotaBytes).toBe(1024 ** 3);
		expect(u.inviteId).toBe(id);
	});

	it('guessing codes locks the IP out; a closed server refuses everyone', async () => {
		const ip = freshIp();
		for (let i = 0; i < 8; i++) expect((await registerRaw(`g${i}@example.com`, 'BBBB-BBBB-BBBB-BBBB', ip)).status).toBe(403);
		expect((await registerRaw('g9@example.com', 'BBBB-BBBB-BBBB-BBBB', ip)).status).toBe(429);

		const { code } = await newInvite();
		envMock.env.REGISTRATION_MODE = 'closed';
		try {
			expect((await registerRaw('closed@example.com', code)).body.message).toMatch(/closed/);
		} finally {
			envMock.env.REGISTRATION_MODE = 'invite';
		}
	});

	it('releaseInvite gives a use back (used when a sign-up fails after redeeming)', async () => {
		const { id, code } = await newInvite();
		expect((await redeemInvite(code))?.uses).toBe(1);
		expect(await redeemInvite(code)).toBeNull();
		await releaseInvite(id);
		expect((await redeemInvite(code))?.uses).toBe(1);
	});
});

// ---------------------------------------------------------------------------
describe('storage quota and usage', () => {
	afterAll(() => void (envMock.env.DEFAULT_QUOTA_GB = undefined));

	it('refuses an upload that would exceed the quota, counting unfinished uploads and the trash', async () => {
		envMock.env.DEFAULT_QUOTA_GB = '0.00001'; // 10,737 bytes
		const a = await signup('quota@example.com');
		const u = { user: a.user };

		expect((await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(1, 5000) })).status).toBe(200); // 5,016 pending
		const over = await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(1, 6000) });
		expect(over.status).toBe(413);
		expect(over.body.message).toMatch(/Not enough storage/);

		const st = await call(storage as Handler, 'GET', '/api/storage', u);
		expect(st.body).toMatchObject({ usedBytes: 5016, quotaBytes: 10737, trashBytes: 0 });
	});

	it('trash still counts until purged; purging frees the space', async () => {
		envMock.env.DEFAULT_QUOTA_GB = '0.00001';
		const a = await signup('quota-trash@example.com');
		const u = { user: a.user };
		const id = await finishedFileOfSize(a, 4000); // 4,016
		expect((await call(storage as Handler, 'GET', '/api/storage', u)).body).toMatchObject({ usedBytes: 4016, fileCount: 1 });

		await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'trash', fileIds: [id], folderIds: [] } });
		expect((await call(storage as Handler, 'GET', '/api/storage', u)).body).toMatchObject({ usedBytes: 4016, trashBytes: 4016, fileCount: 0 });
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(1, 8000) })).status).toBe(413);

		await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'purge', fileIds: [id], folderIds: [] } });
		expect((await call(storage as Handler, 'GET', '/api/storage', u)).body).toMatchObject({ usedBytes: 0, trashBytes: 0 });
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(1, 8000) })).status).toBe(200);
	});

	it("only an admin can change a user's quota; 0 = unlimited, null = back to the default", async () => {
		envMock.env.DEFAULT_QUOTA_GB = '0.00001';
		const a = await signup('quota-admin@example.com');
		const admin = await adminUser();
		const big = initBody(10, 4 * 1024 ** 3);

		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: a.user, body: big })).status).toBe(413);
		expect((await call(patchUser as Handler, 'PATCH', `/api/admin/users/${a.user.id}`, { user: a.user, params: { id: a.user.id }, body: { quotaGb: 0 } })).status).toBe(403);

		expect((await call(patchUser as Handler, 'PATCH', `/api/admin/users/${a.user.id}`, { user: admin, params: { id: a.user.id }, body: { quotaGb: 0 } })).status).toBe(200);
		expect((await call(storage as Handler, 'GET', '/api/storage', { user: a.user })).body.quotaBytes).toBe(0);
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: a.user, body: big })).status).toBe(200);

		await call(patchUser as Handler, 'PATCH', `/api/admin/users/${a.user.id}`, { user: admin, params: { id: a.user.id }, body: { quotaGb: null } });
		expect((await call(storage as Handler, 'GET', '/api/storage', { user: a.user })).body.quotaBytes).toBe(10737);
		expect((await call(patchUser as Handler, 'PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000', { user: admin, params: { id: '00000000-0000-4000-8000-000000000000' }, body: { quotaGb: 1 } })).status).toBe(404);
	});

	it('the admin user list shows usage and flags admins, with no key material', async () => {
		envMock.env.DEFAULT_QUOTA_GB = '5';
		const a = await signup('listed@example.com');
		await finishedFileOfSize(a, 1234);
		const res = await call(adminUsers as Handler, 'GET', '/api/admin/users', { user: await adminUser() });
		const row = res.body.users.find((x: any) => x.email === 'listed@example.com');
		expect(row).toMatchObject({ usedBytes: 1250, isAdmin: false, quotaBytes: 5 * 1024 ** 3 });
		expect(res.body.users.find((x: any) => x.email === 'admin@example.com').isAdmin).toBe(true);
		expect(JSON.stringify(res.body)).not.toMatch(/wrappedPrivateKey|authHash|recovery|totp/i);
		expect((await call(adminUsers as Handler, 'GET', '/api/admin/users', { user: a.user })).status).toBe(403);
	});
});

// ---------------------------------------------------------------------------
describe('sessions (sign out any device)', () => {
	it('three sign-ins in one browser keep one device and invalidate the older tokens', async () => {
		const account = await signup('one-device@example.com', 'device password!!');
		const jar = new Map(account.cookies);
		let firstToken: string | undefined;
		let deviceId: string | undefined;
		let sessionId: string | undefined;
		for (let i = 0; i < 3; i++) {
			const result = await call(login as Handler, 'POST', '/api/auth/login', { cookies: jar, body: { email: account.user.email, password: 'device password!!' }, headers: { 'User-Agent': i === 2 ? 'Chrome/130 Windows' : 'Chrome/129 Windows' }, ip: i === 2 ? '10.9.0.2' : '10.9.0.1' });
			expect(result.status).toBe(200);
			const current = await sessionOf(result);
			if (i === 0) { firstToken = current.token; deviceId = jar.get('e2e_device'); sessionId = current.user!.sessionId; }
			expect(jar.get('e2e_device')).toBe(deviceId);
			expect(current.user!.sessionId).toBe(sessionId);
		}
		const active = await db.select().from(sessions).where(and(eq(sessions.userId, account.user.id), eq(sessions.deviceId, deviceId!)));
		expect(active).toHaveLength(1);
		expect(active[0].tokenVersion).toBe(4);
		expect(await db.select().from(sessions).where(eq(sessions.userId, account.user.id))).toHaveLength(1);
		expect(active[0].userAgent).toBe('Chrome/130 Windows');
		expect(await hookUser(firstToken, deviceId)).toBeNull();
		const current = await sessionOf({ status: 200, body: {}, cookies: jar });
		const listing = await call(sessionsList as Handler, 'GET', '/api/auth/sessions', { user: current.user });
		expect(listing.body.sessions.filter((row: any) => row.id === sessionId)).toHaveLength(1);
	});

	it('keeps separate browsers with identical user-agent and IP distinct', async () => {
		const account = await signup('separate-devices@example.com', 'device password!!');
		const signIn = (jar: Map<string, string>) => call(login as Handler, 'POST', '/api/auth/login', { cookies: jar, body: { email: account.user.email, password: 'device password!!' }, headers: { 'User-Agent': 'Chrome/130 Windows' }, ip: '10.9.1.1' });
		const one = await sessionOf(await signIn(new Map()));
		const two = await sessionOf(await signIn(new Map()));
		expect(one.user!.sessionId).not.toBe(two.user!.sessionId);
		expect((await call(sessionsList as Handler, 'GET', '/api/auth/sessions', { user: one.user })).body.sessions.filter((row: any) => row.userAgent === 'Chrome/130 Windows')).toHaveLength(2);
	});

	it('logout keeps browser identity, and a later sign-in never revives a revoked token', async () => {
		const account = await signup('device-relogin@example.com', 'device password!!');
		const jar = new Map<string, string>();
		const before = await sessionOf(await call(login as Handler, 'POST', '/api/auth/login', { cookies: jar, body: { email: account.user.email, password: 'device password!!' } }));
		const identity = jar.get('e2e_device');
		await call(logout as Handler, 'POST', '/api/auth/logout', { cookies: jar, user: before.user });
		expect(jar.get('e2e_device')).toBe(identity);
		const after = await sessionOf(await call(login as Handler, 'POST', '/api/auth/login', { cookies: jar, body: { email: account.user.email, password: 'device password!!' } }));
		expect(after.user!.sessionId).toBe(before.user!.sessionId);
		expect(await hookUser(before.token, identity)).toBeNull();
		expect(after.user!.id).toBe(account.user.id);
	});

	it('adopts the current legacy session and retires only untracked sign-ins for that account', async () => {
		const account = await signup('device-legacy@example.com', 'device password!!');
		const [current] = await db.select().from(sessions).where(eq(sessions.userId, account.user.id));
		await db.update(sessions).set({ deviceId: null }).where(eq(sessions.id, current.id));
		const [old] = await db.insert(sessions).values({ userId: account.user.id, expiresAt: new Date(Date.now() + DAY), userAgent: 'Chrome Windows' }).returning();
		const token = await new SignJWT({ sub: account.user.id, email: account.user.email, sid: current.id }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(envMock.env.SESSION_SECRET!));
		const adopted = await hookUser(token);
		expect(adopted?.sessionId).toBe(current.id);
		const listed = await call(sessionsList as Handler, 'GET', '/api/auth/sessions', { user: adopted });
		expect(listed.body.legacySessionsRetired).toBe(1);
		expect(listed.body.sessions).toHaveLength(1);
		expect((await db.select().from(sessions).where(eq(sessions.id, old.id)))[0].revokedAt).not.toBeNull();
		expect((await hookUser(token))?.sessionId).toBe(current.id);
	});

	it('every login creates a revocable session, validated by the request hook', async () => {
		const a = await signup('sess@example.com', 'session password!');
		const one = await sessionOf(await doLogin('sess@example.com', 'session password!'));
		const two = await sessionOf(await doLogin('sess@example.com', 'session password!'));
		expect(one.user?.sessionId).toBeTruthy();
		expect(one.user?.sessionId).not.toBe(two.user?.sessionId);
		expect(one.user?.id).toBe(a.user.id);

		const list = await call(sessionsList as Handler, 'GET', '/api/auth/sessions', { user: one.user });
		const mine = list.body.sessions.filter((s: any) => s.current);
		expect(mine).toHaveLength(1);
		expect(mine[0].id).toBe(one.user!.sessionId);
		expect(list.body.sessions.length).toBeGreaterThanOrEqual(3); // signup + two logins

		// Signing out device two kills ITS cookie immediately; device one is untouched.
		const del = await call(revokeOne as Handler, 'DELETE', `/api/auth/sessions/${two.user!.sessionId}`, { user: one.user, params: { id: two.user!.sessionId } });
		expect(del.body).toEqual({ ok: true, current: false });
		expect(await hookUser(two.token)).toBeNull();
		expect((await hookUser(one.token))?.sessionId).toBe(one.user!.sessionId);
	});

	it("can't see or revoke another user's sessions", async () => {
		const a = await signup('sess-a@example.com', 'session password!');
		const b = await signup('sess-b@example.com', 'session password!');
		const bs = await sessionOf(await doLogin('sess-b@example.com', 'session password!'));
		const as = await sessionOf(await doLogin('sess-a@example.com', 'session password!'));
		const res = await call(revokeOne as Handler, 'DELETE', `/api/auth/sessions/${bs.user!.sessionId}`, { user: as.user, params: { id: bs.user!.sessionId } });
		expect(res.status).toBe(404);
		expect((await hookUser(bs.token))?.id).toBe(b.user.id);
		expect(a.user.id).not.toBe(b.user.id);
	});

	it('"sign out other devices" keeps only the current session', async () => {
		await signup('sess-others@example.com', 'session password!');
		const keep = await sessionOf(await doLogin('sess-others@example.com', 'session password!'));
		const gone1 = await sessionOf(await doLogin('sess-others@example.com', 'session password!'));
		const gone2 = await sessionOf(await doLogin('sess-others@example.com', 'session password!'));
		const res = await call(revokeOthers as Handler, 'DELETE', '/api/auth/sessions', { user: keep.user });
		expect(res.body.revoked).toBeGreaterThanOrEqual(2);
		expect(await hookUser(gone1.token)).toBeNull();
		expect(await hookUser(gone2.token)).toBeNull();
		expect((await hookUser(keep.token))?.sessionId).toBe(keep.user!.sessionId);
	});

	it('logout revokes the session server-side (a copied cookie stops working)', async () => {
		await signup('sess-logout@example.com', 'session password!');
		const s = await sessionOf(await doLogin('sess-logout@example.com', 'session password!'));
		await call(logout as Handler, 'POST', '/api/auth/logout', { user: s.user });
		expect(await hookUser(s.token)).toBeNull();
	});

	it('revoking the CURRENT session also clears this browser\'s cookie', async () => {
		await signup('sess-self@example.com', 'session password!');
		const s = await sessionOf(await doLogin('sess-self@example.com', 'session password!'));
		const res = await call(revokeOne as Handler, 'DELETE', `/api/auth/sessions/${s.user!.sessionId}`, { user: s.user, params: { id: s.user!.sessionId } });
		expect(res.body.current).toBe(true);
		expect(await hookUser(s.token)).toBeNull();
	});

	it('changing the password signs out every OTHER device, not this one', async () => {
		const a = await signup('sess-pw@example.com', 'old session password');
		const here = await sessionOf(await doLogin('sess-pw@example.com', 'old session password'));
		const there = await sessionOf(await doLogin('sess-pw@example.com', 'old session password'));
		const wrapped = await wrapPrivateKey(a.kp.privateKey, 'new session password', DEFAULT_PBKDF2_PARAMS);
		const res = await call(changePassword as Handler, 'POST', '/api/auth/change-password', {
			user: here.user,
			body: { currentPassword: 'old session password', newPassword: 'new session password', ...wrapped }
		});
		expect(res.status).toBe(200);
		expect(await hookUser(there.token)).toBeNull();
		expect((await hookUser(here.token))?.sessionId).toBe(here.user!.sessionId);
	});

	it('account recovery signs out every session', async () => {
		const a = await signup('sess-rec@example.com', 'lost session password');
		const s = await sessionOf(await doLogin('sess-rec@example.com', 'lost session password'));
		const blob = (await call(recoverBlob as Handler, 'GET', '/api/auth/recover?email=sess-rec@example.com')).body;
		const { privateKeyJwk, authToken } = await unwrapPrivateKeyWithRecovery(blob.recoveryWrappedPrivateKey, blob.recoveryIv, a.recoveryKey);
		const wrapped = await wrapPrivateKey(await importPrivateJwk(privateKeyJwk, 'ECDH-P256', true), 'recovered password!', DEFAULT_PBKDF2_PARAMS);
		const res = await call(recover as Handler, 'POST', '/api/auth/recover', {
			ip: freshIp(),
			body: { email: 'sess-rec@example.com', recoveryAuthToken: authToken, newPassword: 'recovered password!', ...wrapped }
		});
		expect(res.status).toBe(200);
		expect(await hookUser(s.token)).toBeNull();
	});

	it('rejects tokens without a live session: legacy (no sid), forged, expired, tampered', async () => {
		const a = await signup('sess-bad@example.com', 'session password!');
		const secret = new TextEncoder().encode(envMock.env.SESSION_SECRET!);

		// Issued before sessions existed: valid signature, but no `sid`.
		const legacy = await new SignJWT({ sub: a.user.id, email: a.user.email }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret);
		expect(await hookUser(legacy)).toBeNull();

		// Valid signature, `sid` that doesn't exist.
		const forged = await new SignJWT({ sub: a.user.id, email: a.user.email, sid: '00000000-0000-4000-8000-000000000000' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret);
		expect(await hookUser(forged)).toBeNull();

		const s = await sessionOf(await doLogin('sess-bad@example.com', 'session password!'));
		// Right sid, wrong user.
		const other = await signup('sess-bad-2@example.com', 'session password!');
		const swapped = await new SignJWT({ sub: other.user.id, email: other.user.email, sid: s.user!.sessionId }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret);
		expect(await hookUser(swapped)).toBeNull();

		// Tampered signature.
		expect(await hookUser(s.token!.slice(0, -3) + 'abc')).toBeNull();

		// Session row expired server-side even though the JWT hasn't.
		await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, s.user!.sessionId));
		expect(await hookUser(s.token)).toBeNull();
	});

	it('refreshes "last active" only when it is stale', async () => {
		await signup('sess-seen@example.com', 'session password!');
		const s = await sessionOf(await doLogin('sess-seen@example.com', 'session password!'));
		const sid = s.user!.sessionId;
		const readSeen = async () => (await db.select().from(sessions).where(eq(sessions.id, sid)))[0].lastSeenAt.getTime();

		const fresh = await readSeen();
		await hookUser(s.token);
		expect(await readSeen()).toBe(fresh); // not stale → no write

		await db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }).where(eq(sessions.id, sid));
		const old = await readSeen();
		await hookUser(s.token);
		expect(await readSeen()).toBeGreaterThan(old);
	});
});

// ---------------------------------------------------------------------------
describe('cleanup job', () => {
	const cron = (auth?: string) =>
		call(cleanupRoute as Handler, 'GET', '/api/cron/cleanup', { headers: auth ? { Authorization: auth } : {} });

	it('only runs for the cron secret', async () => {
		expect((await cron()).status).toBe(401);
		expect((await cron('Bearer wrong-secret-0123456789')).status).toBe(401);
		expect((await cron(`Bearer ${envMock.env.CRON_SECRET}`)).body).toMatchObject({ failed: [], timedOut: false });

		const saved = envMock.env.CRON_SECRET;
		envMock.env.CRON_SECRET = undefined;
		try {
			expect((await cron('Bearer undefined')).status).toBe(503); // never open when unconfigured
		} finally {
			envMock.env.CRON_SECRET = saved;
		}
	});

	it('purges trash past the retention window — files, their chunks, and folders — and nothing newer', async () => {
		const a = await signup('clean-trash@example.com');
		const u = { user: a.user };
		const old = await finishedFileOfSize(a, 100);
		const recent = await finishedFileOfSize(a, 100);
		const live = await finishedFileOfSize(a, 100);
		await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'trash', fileIds: [old, recent], folderIds: [] } });
		await db.update(encryptedFiles).set({ deletedAt: new Date(Date.now() - 31 * DAY) }).where(eq(encryptedFiles.id, old));
		await db.update(encryptedFiles).set({ deletedAt: new Date(Date.now() - 5 * DAY) }).where(eq(encryptedFiles.id, recent));

		const payload = { encryptedBlob: b64(30), iv: b64(12), algo: 'AES-GCM', wrappedKey: b64(48), keyAlgo: 'ECDH-P256', keyWrapIv: b64(12), keyWrapEphemeralPublicKeyJwk: { kty: 'EC' } };
		const oldFolder = (await call(createFolder as Handler, 'POST', '/api/folders', { ...u, body: payload })).body.id;
		await call(trash as Handler, 'POST', '/api/trash', { ...u, body: { action: 'trash', fileIds: [], folderIds: [oldFolder] } });
		await db.update(folders).set({ deletedAt: new Date(Date.now() - 40 * DAY) }).where(eq(folders.id, oldFolder));

		const stats = await runCleanup();
		expect(stats.trashFilesPurged).toBeGreaterThanOrEqual(1);
		expect(stats.trashFoldersPurged).toBeGreaterThanOrEqual(1);

		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, old))).toHaveLength(0);
		expect(mem.blobs.has(`${a.user.id}/${old}/chunk-0`)).toBe(false);
		expect(await db.select().from(folders).where(eq(folders.id, oldFolder))).toHaveLength(0);

		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, recent))).toHaveLength(1); // 5 days: kept
		expect(mem.blobs.has(`${a.user.id}/${recent}/chunk-0`)).toBe(true);
		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, live))).toHaveLength(1);
	});

	it('discards uploads abandoned for 48h+ (with their chunks) but not recent ones', async () => {
		const a = await signup('clean-abandoned@example.com');
		const u = { user: a.user };
		const stale = (await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(2, 100) })).body.fileId;
		const fresh = (await call(upload as Handler, 'POST', '/api/files/upload', { ...u, body: initBody(2, 100) })).body.fileId;
		mem.blobs.set(`${a.user.id}/${stale}/chunk-0`, new Uint8Array(10));
		mem.blobs.set(`${a.user.id}/${fresh}/chunk-0`, new Uint8Array(10));
		await db.update(encryptedFiles).set({ createdAt: new Date(Date.now() - 3 * DAY) }).where(eq(encryptedFiles.id, stale));

		const stats = await runCleanup();
		expect(stats.abandonedUploadsPurged).toBeGreaterThanOrEqual(1);
		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, stale))).toHaveLength(0);
		expect(mem.blobs.has(`${a.user.id}/${stale}/chunk-0`)).toBe(false);
		expect(await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, fresh))).toHaveLength(1);
		expect(mem.blobs.has(`${a.user.id}/${fresh}/chunk-0`)).toBe(true);
	});

	it('removes expired and long-revoked sessions only', async () => {
		const a = await signup('clean-sess@example.com');
		const mk = (over: Partial<typeof sessions.$inferInsert>) =>
			db.insert(sessions).values({ userId: a.user.id, expiresAt: new Date(Date.now() + DAY), ...over }).returning({ id: sessions.id });
		const [expired] = await mk({ expiresAt: new Date(Date.now() - 10 * DAY) });
		const [revokedOld] = await mk({ revokedAt: new Date(Date.now() - 10 * DAY) });
		const [revokedRecent] = await mk({ revokedAt: new Date(Date.now() - 1 * DAY) });
		const [live] = await mk({});

		const stats = await runCleanup();
		expect(stats.sessionsRemoved).toBeGreaterThanOrEqual(2);
		const exists = async (id: string) => (await db.select().from(sessions).where(eq(sessions.id, id))).length === 1;
		expect(await exists(expired.id)).toBe(false);
		expect(await exists(revokedOld.id)).toBe(false);
		expect(await exists(revokedRecent.id)).toBe(true);
		expect(await exists(live.id)).toBe(true);
	});

	it('sweeps orphaned chunks: old ones with no database row go; young, live and unrelated objects stay', async () => {
		const a = await signup('clean-orphan@example.com');
		const live = await finishedFileOfSize(a, 50);
		const ghostOwner = crypto.randomUUID();
		const oldOrphans = [0, 1, 2, 3].map((i) => `${ghostOwner}/${crypto.randomUUID()}/chunk-${i}`);
		const youngOrphan = `${ghostOwner}/${crypto.randomUUID()}/chunk-0`;
		const stray = 'README.txt';
		for (const k of oldOrphans) {
			mem.blobs.set(k, new Uint8Array(8));
			mem.times.set(k, Date.now() - 3 * DAY);
		}
		mem.blobs.set(youngOrphan, new Uint8Array(8)); // just uploaded: could be an in-flight upload
		mem.blobs.set(stray, new Uint8Array(8));
		mem.times.set(stray, Date.now() - 30 * DAY);

		const stats = await runCleanup();
		expect(stats.orphanSweepComplete).toBe(true);
		expect(stats.orphanObjectsDeleted).toBe(4);
		for (const k of oldOrphans) expect(mem.blobs.has(k)).toBe(false);
		expect(mem.blobs.has(youngOrphan)).toBe(true);
		expect(mem.blobs.has(stray)).toBe(true);
		expect(mem.blobs.has(`${a.user.id}/${live}/chunk-0`)).toBe(true);
		mem.blobs.delete(youngOrphan);
		mem.blobs.delete(stray);
	});

	it('resumes a big sweep across runs from a saved cursor', async () => {
		const ghostOwner = crypto.randomUUID();
		const keys = Array.from({ length: 7 }, (_, i) => `${ghostOwner}/${crypto.randomUUID()}/chunk-${i}`);
		for (const k of keys) {
			mem.blobs.set(k, new Uint8Array(4));
			mem.times.set(k, Date.now() - 5 * DAY);
		}
		mem.pageSize = 3;
		try {
			// One page per run → the first run can't finish the bucket and must save where it stopped.
			const first = await runCleanup({ maxOrphanPages: 1 });
			expect(first.orphanSweepComplete).toBe(false);
			const [cursor] = await db.select().from(maintenanceState);
			expect(cursor?.key).toBe('orphan_sweep_cursor');

			let done = false;
			for (let i = 0; i < 20 && !done; i++) done = (await runCleanup({ maxOrphanPages: 1 })).orphanSweepComplete;
			expect(done).toBe(true);
			expect(await db.select().from(maintenanceState)).toHaveLength(0); // cursor cleared after a full pass
			for (const k of keys) expect(mem.blobs.has(k)).toBe(false);
		} finally {
			mem.pageSize = 1000;
		}
	});

	it('stops cleanly when the time budget is gone', async () => {
		const stats = await runCleanup({ budgetMs: 0 });
		expect(stats.timedOut).toBe(true);
	});
});

/** Real browser crypto talking to the real handlers and the in-memory B2 store. */
function installRouteNetwork(user: { id: string; email: string }) {
	vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'http://app.test');
		const method = (init?.method ?? 'GET').toUpperCase();
		if (url.hostname === 'b2.test' && method === 'PUT') {
			mem.blobs.set(url.pathname.slice(1), Uint8Array.from(init?.body as Uint8Array));
			return new Response(null, { status: 200 });
		}
		let handler: Handler | undefined;
		let params: Record<string, string> = {};
		if (url.pathname === '/api/files/upload') handler = ({ POST: upload, GET: uploadStatus, DELETE: uploadAbort, PUT: uploadRelay } as Record<string, Handler>)[method];
		else if (url.pathname === '/api/files') handler = listFiles as Handler;
		else if (url.pathname === '/api/shares') handler = allLinks as Handler;
		else {
			let match;
			if ((match = /^\/api\/files\/([^/]+)\/versions\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname))) { handler = versionChunk as Handler; params = { id: match[1], versionId: match[2], index: match[3] }; }
			else if ((match = /^\/api\/files\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname))) { handler = versionRestore as Handler; params = { id: match[1], versionId: match[2] }; }
			else if ((match = /^\/api\/files\/([^/]+)\/versions$/.exec(url.pathname))) { handler = versionList as Handler; params = { id: match[1] }; }
			else if ((match = /^\/api\/files\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname))) { handler = chunkRoute as Handler; params = { id: match[1], index: match[2] }; }
			else if ((match = /^\/api\/files\/([^/]+)\/thumbnail$/.exec(url.pathname))) { handler = (method === 'GET' ? thumbnailGet : thumbnailPut) as Handler; params = { id: match[1] }; }
			else if ((match = /^\/api\/files\/([^/]+)\/share$/.exec(url.pathname))) { handler = ({ GET: fileLinks, POST: shareCreate, DELETE: shareRevoke } as Record<string, Handler>)[method]; params = { id: match[1] }; }
			else if ((match = /^\/api\/share\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname))) { handler = publicChunk as Handler; params = { token: match[1], index: match[2] }; }
			else if ((match = /^\/api\/share\/([^/]+)$/.exec(url.pathname))) { handler = (method === 'POST' ? beginShareDownload : publicShare) as Handler; params = { token: match[1] }; }
		}
		if (!handler) throw new Error(`Unhandled test request: ${method} ${url.pathname}`);
		const result = await call(handler, method, url.pathname + url.search, { user, params, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: Object.fromEntries(new Headers(init?.headers)) });
		return result.bytes ? new Response(result.bytes, { status: result.status, headers: { 'Content-Type': 'application/octet-stream' } })
			: new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
	}));
}

const currentRecord = async (id: string) => (await (await fetch('/api/files')).json()).files.find((file: EncryptedFileRecord) => file.id === id) as EncryptedFileRecord;
const uploadText = (account: Awaited<ReturnType<typeof signup>>, text: string, replaces?: EncryptedFileRecord) => encryptAndUploadFile({
	file: new File([text], 'original.txt', { type: 'text/plain' }), recipientPublicKey: account.kp.publicKey,
	choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' }, replacesFileId: replaces?.id, baseVersion: replaces?.versionNumber
});

describe('encrypted content revisions', () => {
	it('replaces and restores real encrypted content, keeps the file id/name/folder, and counts reused storage once', async () => {
		const account = await signup('versions-roundtrip@example.com');
		installRouteNetwork(account.user);
		try {
			const { fileId } = await uploadText(account, 'first content');
			const original = await currentRecord(fileId);
			await uploadText(account, 'second and longer content', original);
			let current = await currentRecord(fileId);
			expect(current.versionNumber).toBe(2);
			await expect((await downloadAndDecryptFile(current, await unwrapRecordFileKey(current, account.kp.privateKey))).blob.text()).resolves.toBe('second and longer content');
			const history = await (await fetch(`/api/files/${fileId}/versions`)).json();
			expect(history.versions).toHaveLength(1);
			const old = history.versions[0] as EncryptedFileRecord;
			expect(await (await downloadAndDecryptFile(old, await unwrapRecordFileKey(old, account.kp.privateKey))).blob.text()).toBe('first content');
			const folderId = crypto.randomUUID();
			const patch = await reencryptFileMeta(current, account.kp.privateKey, { name: 'renamed.txt', folderId });
			await call(patchFile as Handler, 'PATCH', `/api/files/${fileId}`, { user: account.user, params: { id: fileId }, body: patch });
			current = await currentRecord(fileId);
			await restoreFileVersion(current, old, account.kp.privateKey);
			const restored = await currentRecord(fileId);
			expect(restored.versionNumber).toBe(3);
			const key = await unwrapRecordFileKey(restored, account.kp.privateKey);
			expect(await decryptRecordMetadata(restored, key)).toMatchObject({ name: 'renamed.txt', folderId });
			expect(await (await downloadAndDecryptFile(restored, key)).blob.text()).toBe('first content');
			const usage = await getUsage(account.user.id);
			expect(usage.usedBytes).toBe(original.ciphertextSizeBytes! + current.ciphertextSizeBytes!);
			expect(usage.fileCount).toBe(1);
		} finally { vi.unstubAllGlobals(); }
	});

	it('leaves current content untouched when a replacement is incomplete or discarded', async () => {
		const account = await signup('versions-incomplete@example.com');
		const id = await finishedFileOfSize(account, 20);
		const oldKey = `${account.user.id}/${id}/chunk-0`;
		const pending = await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { ...initBody(2, 100), replacesFileId: id, baseVersion: 1 } });
		mem.blobs.set(`${account.user.id}/${pending.body.fileId}/chunk-0`, new Uint8Array(60));
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { action: 'finalize', fileId: pending.body.fileId, ciphertextSha256: 'a'.repeat(64) } })).status).toBe(409);
		expect((await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, id)))[0].versionNumber).toBe(1);
		expect(await db.select().from(fileVersions).where(eq(fileVersions.fileId, id))).toHaveLength(0);
		await call(uploadAbort as Handler, 'DELETE', `/api/files/upload?fileId=${pending.body.fileId}`, { user: account.user });
		expect(mem.blobs.has(oldKey)).toBe(true);
		expect((await call(listFiles as Handler, 'GET', '/api/files', { user: account.user })).body.files).toHaveLength(1);
	});

	it('rejects stale overwrites and isolates another user from history, restoration and chunks', async () => {
		const account = await signup('versions-conflict@example.com');
		const other = await signup('versions-conflict-other@example.com');
		const id = await finishedFileOfSize(account, 20);
		const pending = [];
		for (let i = 0; i < 2; i++) {
			const response = await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { ...initBody(1, 25 + i), replacesFileId: id, baseVersion: 1 } });
			pending.push(response.body.fileId);
			mem.blobs.set(`${account.user.id}/${response.body.fileId}/chunk-0`, new Uint8Array(41 + i));
		}
		const first = await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { action: 'finalize', fileId: pending[0], ciphertextSha256: 'd'.repeat(64) } });
		expect(first.body).toMatchObject({ fileId: id, versionNumber: 2 });
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { action: 'finalize', fileId: pending[0], ciphertextSha256: 'd'.repeat(64) } })).body).toMatchObject({ fileId: id, versionNumber: 2 });
		expect((await call(patchFile as Handler, 'PATCH', `/api/files/${id}`, { user: account.user, params: { id }, body: { encryptedBlob: b64(30), iv: b64(12), versionNumber: 1 } })).status).toBe(409);
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { action: 'finalize', fileId: pending[1], ciphertextSha256: 'e'.repeat(64) } })).status).toBe(409);
		const [version] = await db.select().from(fileVersions).where(eq(fileVersions.fileId, id));
		expect((await call(versionList as Handler, 'GET', `/api/files/${id}/versions`, { user: other.user, params: { id } })).status).toBe(404);
		expect((await call(versionChunk as Handler, 'GET', `/api/files/${id}/versions/${version.id}/chunks/0`, { user: other.user, params: { id, versionId: version.id, index: '0' } })).status).toBe(404);
		expect((await call(versionRestore as Handler, 'POST', `/api/files/${id}/versions/${version.id}`, { user: other.user, params: { id, versionId: version.id }, body: { baseVersion: 2, metadata: { encryptedBlob: b64(20), iv: b64(12) } } })).status).toBe(404);
		await call(uploadAbort as Handler, 'DELETE', `/api/files/upload?fileId=${pending[1]}`, { user: account.user });
	});

	it('enforces quota before reserving replacement storage', async () => {
		const account = await signup('versions-quota@example.com');
		const id = await finishedFileOfSize(account, 20);
		await db.update(users).set({ storageQuotaBytes: 60 }).where(eq(users.id, account.user.id));
		expect((await call(upload as Handler, 'POST', '/api/files/upload', { user: account.user, body: { ...initBody(1, 20), replacesFileId: id, baseVersion: 1 } })).status).toBe(413);
		expect((await call(listFiles as Handler, 'GET', '/api/files?view=pending', { user: account.user })).body.files).toHaveLength(0);
	});

	it('retains five revisions, pins an active shared version, and protects retained storage from orphan cleanup', async () => {
		const account = await signup('versions-retention@example.com');
		installRouteNetwork(account.user);
		try {
			const { fileId } = await uploadText(account, 'version 1');
			const first = await currentRecord(fileId);
			const link = await createShareLink(first, account.kp.privateKey, 'share password', { kdfParams: DEFAULT_PBKDF2_PARAMS });
			for (let i = 2; i <= 8; i++) await uploadText(account, `version ${i}`, await currentRecord(fileId));
			const versions = await db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId));
			expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 4, 5, 6, 7]);
			const root = (await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, fileId)))[0];
			const protectedKeys = [root.storageKey, ...versions.map((v) => v.storageKey)].map((key) => `${key}/chunk-0`);
			protectedKeys.forEach((key) => mem.times.set(key, Date.now() - 7 * DAY));
			await runCleanup();
			protectedKeys.forEach((key) => expect(mem.blobs.has(key)).toBe(true));
			await call(shareRevoke as Handler, 'DELETE', `/api/files/${fileId}/share?token=${link.token}`, { user: account.user, params: { id: fileId } });
			await runCleanup();
			expect(await db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId))).toHaveLength(4);
			expect(mem.blobs.has(`${account.user.id}/${fileId}/chunk-0`)).toBe(false);
			expect(mem.blobs.has(`${root.storageKey}/chunk-0`)).toBe(true);
		} finally { vi.unstubAllGlobals(); }
	});

	it('retries failed version deletions and permanently deletes every retained/pending object with the file', async () => {
		const account = await signup('versions-purge@example.com');
		installRouteNetwork(account.user);
		try {
			const { fileId } = await uploadText(account, 'version 1');
			const oldKey = `${account.user.id}/${fileId}/chunk-0`;
			mem.failDeletes.add(oldKey);
			for (let i = 2; i <= 6; i++) await uploadText(account, `version ${i}`, await currentRecord(fileId));
			expect(mem.blobs.has(oldKey)).toBe(true);
			expect((await db.select().from(fileVersions).where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.versionNumber, 1))))[0].purgingAt).not.toBeNull();
			mem.failDeletes.clear();
			await runCleanup();
			expect(mem.blobs.has(oldKey)).toBe(false);
			await call(trash as Handler, 'POST', '/api/trash', { user: account.user, body: { action: 'trash', fileIds: [fileId], folderIds: [] } });
			const purged = await call(trash as Handler, 'POST', '/api/trash', { user: account.user, body: { action: 'purge', fileIds: [fileId], folderIds: [] } });
			expect(purged.body.files).toBe(1);
			expect([...mem.blobs.keys()].some((key) => key.startsWith(`${account.user.id}/`))).toBe(false);
			expect((await getUsage(account.user.id)).usedBytes).toBe(0);
		} finally { mem.failDeletes.clear(); vi.unstubAllGlobals(); }
	});
});

describe('encrypted thumbnails', () => {
	it('stores ciphertext only, serves just the derivative, enforces ownership/revision/hash, and counts its bytes', async () => {
		const account = await signup('thumbnail@example.com');
		const other = await signup('thumbnail-other@example.com');
		installRouteNetwork(account.user);
		try {
			const { fileId } = await uploadText(account, 'photo content');
			let record = await currentRecord(fileId);
			const key = await unwrapRecordFileKey(record, account.kp.privateKey);
			const image = new Blob([new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3])], { type: 'image/png' });
			const thumbnail = await encryptPhotoThumbnail(image, key);
			const url = `/api/files/${fileId}/thumbnail`;
			expect((await call(thumbnailPut as Handler, 'PUT', url, { user: account.user, params: { id: fileId }, body: { versionNumber: 2, thumbnail } })).status).toBe(409);
			expect((await call(thumbnailPut as Handler, 'PUT', url, { user: account.user, params: { id: fileId }, body: { versionNumber: 1, thumbnail: { ...thumbnail, ciphertextSha256: '0'.repeat(64) } } })).status).toBe(400);
			expect((await call(thumbnailPut as Handler, 'PUT', url, { user: account.user, params: { id: fileId }, body: { versionNumber: 1, thumbnail } })).status).toBe(200);
			record = await currentRecord(fileId);
			const response = await call(thumbnailGet as Handler, 'GET', `${url}?revision=1`, { user: account.user, params: { id: fileId } });
			const decrypted = await decryptPhotoThumbnail(new Uint8Array(response.bytes!), record.thumbnail!, key);
			expect(new Uint8Array(await decrypted.arrayBuffer())).toEqual(new Uint8Array(await image.arrayBuffer()));
			expect((await getUsage(account.user.id)).usedBytes).toBe(record.ciphertextSizeBytes! + record.thumbnail!.sizeBytes);
			expect((await call(thumbnailGet as Handler, 'GET', url, { user: other.user, params: { id: fileId } })).status).toBe(404);
			expect((await call(thumbnailGet as Handler, 'GET', url, { params: { id: fileId } })).status).toBe(401);
			const stored = [...mem.blobs].find(([object]) => object.startsWith(`${account.user.id}/`) && object.includes('/thumbnail-'))![1];
			expect(stored).not.toEqual(new Uint8Array(await image.arrayBuffer()));
		} finally { vi.unstubAllGlobals(); }
	});
});

describe('share links and immutable downloads', () => {
	it('keeps an existing link decryptable after replacement and lists links only for their owner', async () => {
		const account = await signup('share-version@example.com');
		const other = await signup('share-version-other@example.com');
		installRouteNetwork(account.user);
		try {
			const { fileId } = await uploadText(account, 'shared original');
			const original = await currentRecord(fileId);
			const link = await createShareLink(original, account.kp.privateKey, 'share password', { kdfParams: DEFAULT_PBKDF2_PARAMS });
			await uploadText(account, 'new private version', original);
			const shared = (await call(publicShare as Handler, 'GET', `/api/share/${link.token}`, { params: { token: link.token } })).body;
			expect(shared.versionNumber).toBe(1);
			expect(shared.ciphertextSha256).toBe(original.ciphertextSha256);
			const admission = await call(beginShareDownload as Handler, 'POST', `/api/share/${link.token}`, { params: { token: link.token }, body: { versionNumber: 1 } });
			const key = await unwrapShareFileKey(shared, 'share password');
			const content = await downloadAndDecryptFile(shareRecordAsEncryptedFileRecord(shared), key, (index) => fetch(`/api/share/${link.token}/chunks/${index}?grant=${admission.body.grant}`));
			expect(await content.blob.text()).toBe('shared original');
			const owned = await call(allLinks as Handler, 'GET', '/api/shares', { user: account.user });
			expect(owned.body.links).toHaveLength(1);
			expect(owned.body.links[0].versionNumber).toBe(1);
			expect(owned.body.files[0].versionNumber).toBe(2);
			expect((await call(allLinks as Handler, 'GET', '/api/shares', { user: other.user })).body.links).toHaveLength(0);
			expect((await call(shareRevoke as Handler, 'DELETE', `/api/files/${fileId}/share?token=${link.token}`, { user: other.user, params: { id: fileId } })).status).toBe(404);
			expect((await call(shareCreate as Handler, 'POST', `/api/files/${fileId}/share`, { user: account.user, params: { id: fileId }, body: { versionNumber: 1, wrappedFileKey: b64(48), kdf: 'PBKDF2', kdfSalt: b64(16), kdfParams: {}, wrapIv: b64(12) } })).status).toBe(409);
		} finally { vi.unstubAllGlobals(); }
	});

	it('allows every chunk of a one-download link, charges once, and revokes an in-flight grant immediately', async () => {
		const account = await signup('share-limit@example.com');
		installRouteNetwork(account.user);
		try {
			const { fileId } = await encryptAndUploadFile({ file: new File([new Uint8Array(2 * 1024 * 1024 + 100)], 'large.bin'), recipientPublicKey: account.kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' } });
			const record = await currentRecord(fileId);
			const link = await createShareLink(record, account.kp.privateKey, 'share password', { kdfParams: DEFAULT_PBKDF2_PARAMS, maxDownloads: 1 });
			const admitted = await call(beginShareDownload as Handler, 'POST', `/api/share/${link.token}`, { params: { token: link.token }, body: { versionNumber: 1 } });
			expect(admitted.status).toBe(200);
			for (const index of [0, 1, 0]) expect((await call(publicChunk as Handler, 'GET', `/api/share/${link.token}/chunks/${index}?grant=${admitted.body.grant}`, { params: { token: link.token, index: String(index) } })).status).toBe(200);
			const exhausted = (await db.select().from(shareLinks).where(eq(shareLinks.token, link.token)))[0];
			expect(exhausted.downloadCount).toBe(1);
			expect(exhausted.revokedAt).not.toBeNull();
			expect(exhausted.revocationReason).toBe('download_limit');
			expect((await call(publicShare as Handler, 'GET', `/api/share/${link.token}`, { params: { token: link.token } })).status).toBe(410);
			// Automatic revocation must keep the admitted version while its grant is valid.
			for (let revision = 2; revision <= 7; revision++) await uploadText(account, `new private version ${revision}`, await currentRecord(fileId));
			await runCleanup();
			expect((await call(publicChunk as Handler, 'GET', `/api/share/${link.token}/chunks/1?grant=${admitted.body.grant}`, { params: { token: link.token, index: '1' } })).status).toBe(200);
			expect((await call(beginShareDownload as Handler, 'POST', `/api/share/${link.token}`, { params: { token: link.token }, body: { versionNumber: 1 } })).status).toBe(410);
			await call(shareRevoke as Handler, 'DELETE', `/api/files/${fileId}/share?token=${link.token}`, { user: account.user, params: { id: fileId } });
			expect((await call(publicChunk as Handler, 'GET', `/api/share/${link.token}/chunks/1?grant=${admitted.body.grant}`, { params: { token: link.token, index: '1' } })).status).toBe(410);
		} finally { vi.unstubAllGlobals(); }
	});

	it('automatically revokes older exhausted links without changing another owner’s links', async () => {
		const account = await signup('old-limit@example.com');
		const other = await signup('old-limit-other@example.com');
		const id = await finishedFileOfSize(account, 8);
		const otherId = await finishedFileOfSize(other, 8);
		const payload = { wrappedFileKey: b64(48), kdf: 'PBKDF2', kdfSalt: b64(16), kdfParams: {}, wrapIv: b64(12), maxDownloads: 2 };
		const one = await call(shareCreate as Handler, 'POST', `/api/files/${id}/share`, { user: account.user, params: { id }, body: payload });
		const two = await call(shareCreate as Handler, 'POST', `/api/files/${otherId}/share`, { user: other.user, params: { id: otherId }, body: payload });
		await db.update(shareLinks).set({ downloadCount: 2 }).where(eq(shareLinks.token, one.body.token));
		await db.update(shareLinks).set({ downloadCount: 2 }).where(eq(shareLinks.token, two.body.token));
		await call(allLinks as Handler, 'GET', '/api/shares', { user: account.user });
		expect((await db.select().from(shareLinks).where(eq(shareLinks.token, one.body.token)))[0].revocationReason).toBe('download_limit');
		expect((await db.select().from(shareLinks).where(eq(shareLinks.token, two.body.token)))[0].revokedAt).toBeNull();
	});
});

describe('backup endpoint boundaries', () => {
	it('rejects unauthenticated cron calls and non-admin status access', async () => {
		expect((await call(backupRoute as Handler, 'GET', '/api/cron/backup')).status).toBe(401);
		expect((await call(adminBackupStatus as Handler, 'GET', '/api/admin/backups')).status).toBe(401);
		expect((await call(adminBackupStatus as Handler, 'GET', '/api/admin/backups', { user: { id: crypto.randomUUID(), email: 'ordinary@example.com' } })).status).toBe(403);
		const admin = (await db.select().from(users).where(eq(users.email, 'admin@example.com')))[0];
		expect((await call(adminBackupStatus as Handler, 'GET', '/api/admin/backups', { user: { id: admin.id, email: admin.email } })).body.configured).toBe(false);
	});
});
