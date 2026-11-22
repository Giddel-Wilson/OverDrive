import { json } from '@sveltejs/kit';
import { requireUser } from '$server/auth';
import { listActiveSessions, revokeSessions, retireUntrackedSessions } from '$server/sessions';
import type { RequestHandler } from './$types';

/** The signed-in browsers / devices for this account. */
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const legacySessionsRetired = await retireUntrackedSessions(user.id, user.sessionId);
	return json({ sessions: await listActiveSessions(user.id, user.sessionId), legacySessionsRetired }, { headers: { 'Cache-Control': 'no-store' } });
};

/** DELETE /api/auth/sessions → sign out every OTHER device (this one stays signed in). */
export const DELETE: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json({ ok: true, revoked: await revokeSessions(user.id, user.sessionId) });
};
