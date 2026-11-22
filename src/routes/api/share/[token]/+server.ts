import { json, error } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$server/db';
import { sharedFile, downloadGrant } from '$server/shared-files';
import { parseBody } from '$server/validate';
import { z } from 'zod';
import type { RequestHandler } from './$types';

/**
 * Returns everything a recipient needs to decrypt a shared file, given
 * only the link token and (separately, entered by the recipient) the
 * share password. No account or session required — but the file's real
 * name is still encrypted inside `metadata`, so this response alone
 * reveals nothing about the file's content.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { link, root, content: file, metadata } = await sharedFile(params.token);

	return json({
		fileId: root.id,
		versionNumber: file.versionNumber,
		fileAlgo: file.fileAlgo,
		fileIv: file.fileIv,
		totalChunks: file.totalChunks,
		ciphertextSha256: file.ciphertextSha256,
		wrappedFileKey: link.wrappedFileKey,
		kdf: link.kdf,
		kdfSalt: link.kdfSalt,
		kdfParams: link.kdfParams,
		wrapIv: link.wrapIv,
		metadata
	}, { headers: { 'Cache-Control': 'no-store' } });
};

/** Reserve once per download attempt, rather than charging every chunk. */
export const POST: RequestHandler = async ({ params, request }) => {
	const { versionNumber } = parseBody(z.object({ versionNumber: z.number().int().min(1) }), await request.json());
	const { link, content } = await sharedFile(params.token);
	if (content.versionNumber !== versionNumber) error(409, 'The shared version changed. Reload this page.');
	const until = new Date(Math.min(Date.now() + 2 * 60 * 60 * 1000, link.expiresAt?.getTime() ?? Infinity));
	const result = await db.execute(sql`UPDATE share_links l SET download_count = download_count + 1,
		download_grant_until = GREATEST(download_grant_until, ${until.toISOString()}::timestamptz),
		revoked_at = CASE WHEN max_downloads IS NOT NULL AND download_count + 1 >= max_downloads THEN now() ELSE revoked_at END,
		revocation_reason = CASE WHEN max_downloads IS NOT NULL AND download_count + 1 >= max_downloads THEN 'download_limit' ELSE revocation_reason END
		WHERE l.id = ${link.id} AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
			AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads)
			AND EXISTS (SELECT 1 FROM encrypted_files f LEFT JOIN file_versions v ON v.id = l.version_id
				WHERE f.id = l.file_id AND f.deleted_at IS NULL AND f.upload_status = 'complete'
				AND COALESCE(v.version_number, f.version_number) = ${versionNumber} AND (v.purging_at IS NULL)) RETURNING l.id`);
	if (result.rows.length === 0) error(410, 'This download is no longer available. Reload the page.');
	return json({ grant: await downloadGrant(params.token, versionNumber, until) }, { headers: { 'Cache-Control': 'no-store' } });
};
