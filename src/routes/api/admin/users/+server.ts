import { json } from '@sveltejs/kit';
import { sql, desc } from 'drizzle-orm';
import { db, users } from '$server/db';
import { requireAdmin, isAdminEmail } from '$server/admin';
import { defaultQuotaBytes } from '$server/quota';
import type { RequestHandler } from './$types';

/** Every account with its storage use. Admin only. Never includes key material. */
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			createdAt: users.createdAt,
			lastLoginAt: users.lastLoginAt,
			quotaOverride: users.storageQuotaBytes,
			used: sql<string>`coalesce((SELECT sum(bytes) FROM (
				SELECT pointer, max(bytes) AS bytes FROM (
					SELECT coalesce(nullif(e.storage_key, ''), e.owner_id::text || '/' || e.id::text) AS pointer,
						e.ciphertext_size_bytes + e.thumbnail_size_bytes AS bytes FROM encrypted_files e WHERE e.owner_id = "users"."id"
					UNION ALL SELECT v.storage_key, v.ciphertext_size_bytes + v.thumbnail_size_bytes
					FROM file_versions v JOIN encrypted_files f ON f.id = v.file_id WHERE f.owner_id = "users"."id"
				) revisions GROUP BY pointer
			) stored), 0)::text`
		})
		.from(users)
		.orderBy(desc(users.createdAt));

	const fallback = defaultQuotaBytes();
	return json({
		defaultQuotaBytes: fallback,
		users: rows.map((r) => ({
			id: r.id,
			email: r.email,
			displayName: r.displayName,
			createdAt: r.createdAt,
			lastLoginAt: r.lastLoginAt,
			usedBytes: Number(r.used),
			quotaOverride: r.quotaOverride,
			quotaBytes: r.quotaOverride ?? fallback,
			isAdmin: isAdminEmail(r.email)
		}))
	});
};
