import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { db, sessions } from './db';

export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Retire pre-device-tracking credentials once, keeping the adopted current browser. */
export async function retireUntrackedSessions(userId: string, currentSessionId: string): Promise<number> {
	const [current] = await db.select({ deviceId: sessions.deviceId }).from(sessions)
		.where(and(eq(sessions.id, currentSessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
	if (!current?.deviceId) return 0;
	const retired = await db.update(sessions).set({ revokedAt: new Date() }).where(and(
		eq(sessions.userId, userId), isNull(sessions.deviceId), isNull(sessions.revokedAt), ne(sessions.id, currentSessionId)
	)).returning({ id: sessions.id });
	return retired.length;
}

export interface SessionInfo {
	id: string;
	createdAt: Date;
	lastSeenAt: Date;
	ipAddress: string | null;
	userAgent: string | null;
	current: boolean;
}

export async function listActiveSessions(userId: string, currentSessionId: string): Promise<SessionInfo[]> {
	const rows = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
	return rows
		.map((r) => ({
			id: r.id,
			createdAt: r.createdAt,
			lastSeenAt: r.lastSeenAt,
			ipAddress: r.ipAddress,
			userAgent: r.userAgent,
			current: r.id === currentSessionId
		}))
		.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

/** Revokes one of the user's own sessions. Returns false if it wasn't theirs / already gone. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
	const done = await db
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });
	return done.length > 0;
}

/** Revokes every session of the user except (optionally) one. */
export async function revokeSessions(userId: string, exceptSessionId?: string): Promise<number> {
	const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
	if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
	const done = await db.update(sessions).set({ revokedAt: new Date() }).where(and(...conditions)).returning({ id: sessions.id });
	return done.length;
}
