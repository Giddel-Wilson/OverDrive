import { json } from '@sveltejs/kit';
import { clearSessionCookie } from '$server/auth-server';
import { revokeSession } from '$server/sessions';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	// Revoke server-side too, so a copy of this cookie stops working immediately.
	if (locals.user) await revokeSession(locals.user.id, locals.user.sessionId);
	clearSessionCookie(cookies);
	return json({ ok: true });
};
