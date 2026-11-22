import { json, error } from '@sveltejs/kit';
import { requireUser } from '$server/auth';
import { clearSessionCookie } from '$server/auth-server';
import { revokeSession } from '$server/sessions';
import type { RequestHandler } from './$types';

/** Signs out one specific device. Revoking the current one also clears this browser's cookie. */
export const DELETE: RequestHandler = async ({ locals, params, cookies }) => {
	const user = requireUser(locals);
	if (!(await revokeSession(user.id, params.id))) error(404, 'Session not found');
	if (params.id === user.sessionId) clearSessionCookie(cookies);
	return json({ ok: true, current: params.id === user.sessionId });
};
