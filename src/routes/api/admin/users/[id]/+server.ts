import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, users } from '$server/db';
import { requireAdmin } from '$server/admin';
import { parseBody } from '$server/validate';
import { GIB } from '$server/quota';
import type { RequestHandler } from './$types';

// quotaGb: a number of GB (0 = unlimited) or null to go back to the server default.
const schema = z.object({ quotaGb: z.number().min(0).max(100_000).nullable() });

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const { quotaGb } = parseBody(schema, await request.json());
	const done = await db
		.update(users)
		.set({ storageQuotaBytes: quotaGb === null ? null : Math.round(quotaGb * GIB) })
		.where(eq(users.id, params.id))
		.returning({ id: users.id });
	if (done.length === 0) error(404, 'User not found');
	return json({ ok: true });
};
