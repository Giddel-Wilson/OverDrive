import { json } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, invites, users } from '$server/db';
import { requireAdmin } from '$server/admin';
import { generateInviteCode, hashInviteCode } from '$server/invites';
import { parseBody } from '$server/validate';
import { GIB } from '$server/quota';
import type { RequestHandler } from './$types';

const createSchema = z.object({
	note: z.string().trim().max(120).optional(),
	maxUses: z.number().int().min(1).max(100).default(1),
	expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
	// Storage for accounts made with this invite, in GB. 0 = unlimited; omitted = server default.
	quotaGb: z.number().min(0).max(100_000).nullable().optional()
});

export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	const rows = await db
		.select({
			id: invites.id,
			note: invites.note,
			maxUses: invites.maxUses,
			uses: invites.uses,
			expiresAt: invites.expiresAt,
			quotaBytes: invites.quotaBytes,
			revokedAt: invites.revokedAt,
			createdAt: invites.createdAt,
			createdByEmail: users.email
		})
		.from(invites)
		.leftJoin(users, eq(users.id, invites.createdBy))
		.orderBy(desc(invites.createdAt));
	return json({ invites: rows });
};

/** Creates an invite. The code is returned ONCE here — only its hash is stored. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = parseBody(createSchema, await request.json());

	const code = generateInviteCode();
	const [row] = await db
		.insert(invites)
		.values({
			codeHash: hashInviteCode(code),
			note: body.note || null,
			createdBy: admin.id,
			maxUses: body.maxUses,
			expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
			quotaBytes: body.quotaGb === undefined || body.quotaGb === null ? null : Math.round(body.quotaGb * GIB)
		})
		.returning({ id: invites.id });

	return json({ id: row.id, code });
};
