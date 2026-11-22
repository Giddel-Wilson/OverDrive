import { error } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, encryptedFiles, users } from './db';
import { formatBytes } from '$lib/shared/limits';

export const GIB = 1024 ** 3;

/** DEFAULT_QUOTA_GB (default 5). 0 means unlimited. */
export function defaultQuotaBytes(): number {
	const raw = env.DEFAULT_QUOTA_GB;
	if (raw === undefined || raw === '') return 5 * GIB;
	const gb = Number(raw);
	return Number.isFinite(gb) && gb >= 0 ? Math.round(gb * GIB) : 5 * GIB;
}

/** The limit that applies to a user: their own override, else the default. 0 = unlimited. */
export async function quotaBytesFor(userId: string): Promise<number> {
	const [u] = await db.select({ q: users.storageQuotaBytes }).from(users).where(eq(users.id, userId));
	return u?.q ?? defaultQuotaBytes();
}

export interface Usage {
	usedBytes: number;
	trashBytes: number;
	fileCount: number;
	quotaBytes: number; // 0 = unlimited
	versionBytes: number;
}

/**
 * Everything the bucket holds for this user counts: finished files, files in
 * the trash (their ciphertext is still stored until purged) and unfinished
 * uploads (at their declared size).
 */
export async function getUsage(userId: string): Promise<Usage> {
	const result = await db.execute(sql`WITH revisions AS (
		SELECT COALESCE(NULLIF(storage_key, ''), owner_id::text || '/' || id::text) AS pointer,
			ciphertext_size_bytes + thumbnail_size_bytes AS bytes, deleted_at IS NOT NULL AS trashed
		FROM encrypted_files WHERE owner_id = ${userId}
		UNION ALL
		SELECT v.storage_key, v.ciphertext_size_bytes + v.thumbnail_size_bytes, f.deleted_at IS NOT NULL
		FROM file_versions v JOIN encrypted_files f ON f.id = v.file_id WHERE f.owner_id = ${userId}
	), stored AS (SELECT pointer, MAX(bytes) AS bytes, bool_or(trashed) AS trashed FROM revisions GROUP BY pointer)
	SELECT COALESCE(SUM(bytes), 0)::text AS used,
		COALESCE(SUM(CASE WHEN trashed THEN bytes ELSE 0 END), 0)::text AS trash,
		(SELECT COUNT(*)::text FROM encrypted_files WHERE owner_id = ${userId} AND deleted_at IS NULL AND upload_status = 'complete' AND replaces_file_id IS NULL) AS files,
		(SELECT COALESCE(SUM(ciphertext_size_bytes + thumbnail_size_bytes), 0)::text FROM encrypted_files WHERE owner_id = ${userId}) AS current
	FROM stored`);
	const row = result.rows[0] as { used: string; trash: string; files: string; current: string } | undefined;

	return {
		usedBytes: Number(row?.used ?? 0),
		trashBytes: Number(row?.trash ?? 0),
		fileCount: Number(row?.files ?? 0),
		quotaBytes: await quotaBytesFor(userId),
		versionBytes: Math.max(0, Number(row?.used ?? 0) - Number(row?.current ?? 0))
	};
}

/**
 * Refuses an upload that would take the user over their limit. This is a
 * soft limit: two uploads started in the same instant can each pass and end
 * up slightly over — fine for storage accounting, not a security boundary.
 */
export async function assertWithinQuota(userId: string, additionalBytes: number) {
	const { usedBytes, quotaBytes } = await getUsage(userId);
	if (quotaBytes === 0) return;
	if (usedBytes + additionalBytes > quotaBytes) {
		error(
			413,
			`Not enough storage: ${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used and this file needs ${formatBytes(additionalBytes)}. Empty the trash, delete something, or ask the admin for more space.`
		);
	}
}
