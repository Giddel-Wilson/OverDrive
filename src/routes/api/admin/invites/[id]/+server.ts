import { json, error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db, invites } from '$server/db';
import { requireAdmin } from '$server/admin';
import type { RequestHandler } from './$types';

/** Revokes an invite. Accounts already created with it are unaffected. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireAdmin(locals);
	const done = await db
		.update(invites)
		.set({ revokedAt: new Date() })
		.where(and(eq(invites.id, params.id), isNull(invites.revokedAt)))
		.returning({ id: invites.id });
	if (done.length === 0) error(404, 'Invite not found');
	return json({ ok: true });
};
