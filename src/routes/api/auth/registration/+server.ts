import { json } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import { db, users } from '$server/db';
import type { RequestHandler } from './$types';

/** Registration is open, including for clients using the earlier availability endpoint. */
export const GET: RequestHandler = async () => {
	const [{ n }] = await db.select({ n: count() }).from(users);
	return json({ mode: 'open', bootstrap: n === 0 });
};
