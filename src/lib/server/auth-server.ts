import { hash, verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { db, sessions } from './db';
import { SESSION_TOUCH_INTERVAL_MS, retireUntrackedSessions, revokeSession } from './sessions';

const SESSION_COOKIE = 'e2e_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEVICE_COOKIE = 'e2e_device';
const DEVICE_TTL_SECONDS = 60 * 60 * 24 * 365;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deviceCookie(cookies: Cookies): string | undefined {
	const value = cookies.get(DEVICE_COOKIE);
	return value && UUID.test(value) ? value.toLowerCase() : undefined;
}
function setDeviceCookie(cookies: Cookies, id: string) {
	cookies.set(DEVICE_COOKIE, id, { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: DEVICE_TTL_SECONDS });
}

function secretKey() {
	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
		throw new Error('SESSION_SECRET is not set (or too short) — set it in your env vars');
	}
	return new TextEncoder().encode(env.SESSION_SECRET);
}

/**
 * Argon2id hash of the LOGIN password — a standard server-side auth
 * verifier. This is intentionally a separate secret from any key used to
 * wrap a user's private key client-side (see crypto/private-key.ts); the
 * server only ever needs this one to authenticate a session.
 */
export async function hashPassword(password: string): Promise<string> {
	return hash(password, { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hashStr: string, password: string): Promise<boolean> {
	return verify(hashStr, password);
}

/**
 * Starts a session: records it in the database (so it can be listed and
 * revoked) and sets a signed cookie carrying its id. Returns the session id.
 */
export async function createSessionCookie(
	cookies: Cookies,
	userId: string,
	email: string,
	meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<string> {
	const previous = await readSessionCookie(cookies);
	if (previous && previous.id !== userId) await revokeSession(previous.id, previous.sessionId);
	const deviceId = deviceCookie(cookies) ?? randomUUID();
	const now = new Date();
	const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
	const [row] = await db
		.insert(sessions)
		.values({
			userId,
			deviceId,
			expiresAt,
			ipAddress: meta.ip ?? null,
			userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null
		})
		.onConflictDoUpdate({
			target: [sessions.userId, sessions.deviceId],
			set: { tokenVersion: sql`${sessions.tokenVersion} + 1`, expiresAt, lastSeenAt: now,
				ipAddress: meta.ip ?? null, userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null, revokedAt: null }
		})
		.returning({ id: sessions.id, tokenVersion: sessions.tokenVersion });
	await retireUntrackedSessions(userId, row.id);

	const token = await new SignJWT({ sub: userId, email, sid: row.id, ver: row.tokenVersion })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${SESSION_TTL_SECONDS}s`)
		.sign(secretKey());

	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: SESSION_TTL_SECONDS
	});
	setDeviceCookie(cookies, deviceId);
	return row.id;
}

export function clearSessionCookie(cookies: Cookies) {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

/**
 * Validates the session cookie: a good signature AND a live session row
 * (not revoked, not expired, same user). Tokens issued before sessions
 * existed carry no `sid` and are treated as signed out.
 */
export async function readSessionCookie(
	cookies: Cookies
): Promise<{ id: string; email: string; sessionId: string } | null> {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return null;
	try {
		const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
		const sid = payload.sid;
		const version = payload.ver === undefined ? 1 : payload.ver;
		if (typeof sid !== 'string' || typeof payload.sub !== 'string' || typeof payload.email !== 'string'
			|| typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null;

		const [row] = await db
			.select({ id: sessions.id, lastSeenAt: sessions.lastSeenAt, deviceId: sessions.deviceId })
			.from(sessions)
			.where(
				and(eq(sessions.id, sid), eq(sessions.userId, payload.sub), eq(sessions.tokenVersion, version), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()))
			);
		if (!row) return null;

		const remembered = deviceCookie(cookies);
		let deviceId = row.deviceId;
		if (!deviceId) {
			const candidate = remembered ?? randomUUID();
			const [alreadyBound] = await db.select({ id: sessions.id }).from(sessions)
				.where(and(eq(sessions.userId, payload.sub), eq(sessions.deviceId, candidate)));
			if (alreadyBound && alreadyBound.id !== sid) return null;
			const [adopted] = await db.update(sessions).set({ deviceId: candidate })
				.where(and(eq(sessions.id, sid), isNull(sessions.deviceId), eq(sessions.tokenVersion, version), isNull(sessions.revokedAt)))
				.returning({ deviceId: sessions.deviceId });
			deviceId = adopted?.deviceId ?? (await db.select({ deviceId: sessions.deviceId }).from(sessions).where(eq(sessions.id, sid)))[0]?.deviceId ?? null;
			if (!deviceId) return null;
		}
		if (remembered && remembered !== deviceId) return null;
		if (!remembered) setDeviceCookie(cookies, deviceId);

		// "Last active" is refreshed at most every few minutes, not on every request.
		if (Date.now() - row.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
			await db.update(sessions).set({ lastSeenAt: new Date() }).where(and(eq(sessions.id, sid), eq(sessions.tokenVersion, version)));
		}
		return { id: payload.sub, email: payload.email as string, sessionId: sid };
	} catch {
		return null;
	}
}
