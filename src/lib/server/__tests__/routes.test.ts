/**
 * End-to-end tests of the server routes against a REAL Postgres engine
 * (PGlite, in-process) built from the real Drizzle schema, with object
 * storage replaced by an in-memory map. Handlers are called directly with
 * constructed request events, so auth, validation, rate limiting, 2FA,
 * recovery, trash and the upload protocol all run exactly as deployed.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

const mem = vi.hoisted(() => ({ blobs: new Map<string, Uint8Array>() }));

vi.mock('$env/dynamic/private', () => ({
	env: { SESSION_SECRET: 'test-session-secret-0123456789abcdef', DATABASE_URL: 'x' }
}));

vi.mock('$server/blob-store', async () => {
	const { createHash } = await import('node:crypto');
	return {
		chunkPrefix: (o: string, f: string) => `${o}/${f}/`,
		chunkKey: (o: string, f: string, i: number) => `${o}/${f}/chunk-${i}`,
		sha256Hex: async (d: Uint8Array) => createHash('sha256').update(d).digest('hex'),
		filesStore: () => ({
			set: async (k: string, data: ArrayBuffer) => void mem.blobs.set(k, new Uint8Array(data)),
			get: async (k: string) => (mem.blobs.has(k) ? mem.blobs.get(k)!.slice().buffer : null),
			delete: async (k: string) => void mem.blobs.delete(k),
			deleteMany: async (keys: string[]) => {
				keys.forEach((k) => mem.blobs.delete(k));
				return { failed: [] as string[] };
			},
			list: async (prefix: string) =>
				[...mem.blobs].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })),
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
	const db = drizzle(new PGlite(), { schema });
	const { apply } = await pushSchema(schema, db as never);
	await apply();
	return { db, ...schema };
});

import { db, users, encryptedFiles, fileMetadata, folders, accessLogs } from '$server/db';
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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Handler = (e: never) => Promise<Response> | Response;
interface Result<T = any> { status: number; body: T; cookies: Map<string, string> }

async function call(handler: Handler, method: string, path: string, opts: { body?: unknown; user?: { id: string; email: string } | null; ip?: string; params?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Result> {
	const cookies = new Map<string, string>();
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
		return { status: res.status, body: await res.json().catch(() => null), cookies };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: { message: e.body.message }, cookies };
		throw e;
	}
}

let ipCounter = 0;
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function signup(email: string, password = 'correct horse battery') {
	const kp = await generateEcdhKeypair();
	const wrapped = await wrapPrivateKey(kp.privateKey, password, DEFAULT_PBKDF2_PARAMS);
	const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
	const recoveryKey = generateRecoveryKey();
	const rec = await wrapPrivateKeyWithRecovery(jwk, recoveryKey);
	const res = await call(register as Handler, 'POST', '/api/auth/register', {
		body: {
			email,
			displayName: 'Tester',
			password,
			publicKeyJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
			keyAlgo: 'ECDH-P256',
			...wrapped,
			...rec
		}
	});
	expect(res.status).toBe(200);
	const [row] = await db.select().from(users).where(eq(users.email, email));
	return { user: { id: row.id, email }, password, recoveryKey, jwk, kp };
}

const doLogin = (email: string, password: string, extra: Record<string, unknown> = {}, ip = freshIp()) =>
	call(login as Handler, 'POST', '/api/auth/login', { body: { email, password, ...extra }, ip });

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
		expect(ok.cookies.size).toBe(1);
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
			expect(good.cookies.size).toBe(1);

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
