import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, users } from '$server/db';
import { requireUser } from '$server/auth';
import { isAdminEmail } from '$server/admin';
import type { RequestHandler } from './$types';

/** Minimal "who am I" for the settings pages (the session cookie only carries an id). */
export const GET: RequestHandler = async ({ locals }) => {
	const sessionUser = requireUser(locals);
	const [user] = await db
		.select({ id: users.id, email: users.email, displayName: users.displayName })
		.from(users)
		.where(eq(users.id, sessionUser.id));
	const me = user ?? { id: sessionUser.id, email: sessionUser.email, displayName: null };
	return json({ ...me, isAdmin: isAdminEmail(me.email) });
};
