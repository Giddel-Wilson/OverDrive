import { json } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import { db, users } from '$server/db';
import { configuredRegistrationMode } from '$server/admin';
import type { RequestHandler } from './$types';

/**
 * What the sign-up page should show. On a brand-new deployment (no users
 * yet) sign-up is open so the first account — the admin — can be created;
 * after that it follows REGISTRATION_MODE (default: invite-only).
 */
export const GET: RequestHandler = async () => {
	const [{ n }] = await db.select({ n: count() }).from(users);
	return json(n === 0 ? { mode: 'open', bootstrap: true } : { mode: configuredRegistrationMode(), bootstrap: false });
};
