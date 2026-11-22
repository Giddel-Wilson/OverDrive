import { json, error } from '@sveltejs/kit';
import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, encryptedFiles, shareLinks, fileVersions, runTransaction } from '$server/db';
import { requireUser } from '$server/auth';
import { logAccess } from '$server/access-log';
import { parseBody } from '$server/validate';
import { shareCreateSchema } from '$server/schemas';
import { ownedCurrentFile } from '$server/versions';
import { autoRevokeLimitedLinks } from '$server/shared-files';
import type { RequestHandler } from './$types';

/** Lists this file's share links (owner-only) so the dashboard can manage them. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals);

	const [file] = await db
		.select({ id: encryptedFiles.id })
		.from(encryptedFiles)
		.where(and(eq(encryptedFiles.id, params.id), eq(encryptedFiles.ownerId, user.id)));
	if (!file) error(404, 'File not found');
	await autoRevokeLimitedLinks({ ownerId: user.id, fileId: file.id });

	const links = await db
		.select({
			id: shareLinks.id,
			token: shareLinks.token,
			maxDownloads: shareLinks.maxDownloads,
			downloadCount: shareLinks.downloadCount,
			expiresAt: shareLinks.expiresAt,
			revokedAt: shareLinks.revokedAt,
			revocationReason: shareLinks.revocationReason,
			downloadGrantUntil: shareLinks.downloadGrantUntil,
			createdAt: shareLinks.createdAt,
			versionNumber: sql<number | null>`CASE WHEN ${shareLinks.versionId} IS NULL AND ${shareLinks.createdAt} < ${encryptedFiles.contentUpdatedAt} THEN NULL ELSE coalesce(${fileVersions.versionNumber}, ${encryptedFiles.versionNumber}) END`,
			fileInTrash: sql<boolean>`${encryptedFiles.deletedAt} IS NOT NULL`
		})
		.from(shareLinks)
		.innerJoin(encryptedFiles, eq(encryptedFiles.id, shareLinks.fileId))
		.leftJoin(fileVersions, eq(fileVersions.id, shareLinks.versionId))
		.where(eq(shareLinks.fileId, file.id))
		.orderBy(desc(shareLinks.createdAt));

	return json({ links });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals);
	const { wrappedFileKey, kdf, kdfSalt, kdfParams, wrapIv, maxDownloads, expiresAt, versionNumber } = parseBody(
		shareCreateSchema,
		await request.json()
	);

	const file = await ownedCurrentFile(params.id, user.id);
	if (file.versionNumber !== versionNumber) error(409, 'This file changed. Refresh before creating a link.');
	if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) error(400, 'Choose an expiry in the future');

	const token = nanoid(24);

	const guard = sql`id = ${file.id} AND owner_id = ${user.id} AND version_number = ${versionNumber} AND deleted_at IS NULL AND upload_status = 'complete'`;
	const result = await runTransaction([
		sql`SELECT id FROM encrypted_files WHERE ${guard} FOR UPDATE`,
		sql`INSERT INTO share_links (file_id, token, wrapped_file_key, kdf, kdf_salt, kdf_params, wrap_iv, max_downloads, expires_at)
			SELECT id, ${token}, ${wrappedFileKey}, ${kdf}::kdf_algo, ${kdfSalt}, ${JSON.stringify(kdfParams)}::jsonb, ${wrapIv}, ${maxDownloads ?? null}::integer, ${expiresAt ?? null}::timestamptz
			FROM encrypted_files WHERE ${guard} RETURNING id`
	]);
	if (result[1].length === 0) error(409, 'This file changed. Refresh before creating a link.');

	await logAccess({ fileId: file.id, actorId: user.id, action: 'SHARE_CREATE', success: true });

	return json({ token, url: `/share/${token}` });
};

export const DELETE: RequestHandler = async ({ params, locals, url }) => {
	const user = requireUser(locals);
	const token = url.searchParams.get('token');
	if (!token) error(400, 'Missing token');

	// Verify the link both matches this file AND belongs to a file this
	// user owns before revoking — without the ownership join, any signed-in
	// user could revoke any link by guessing/knowing its token.
	const [file] = await db
		.select({ id: encryptedFiles.id })
		.from(encryptedFiles)
		.where(and(eq(encryptedFiles.id, params.id), eq(encryptedFiles.ownerId, user.id)));
	if (!file) error(404, 'File not found');

	const [link] = await db
		.select({ id: shareLinks.id })
		.from(shareLinks)
		.where(and(eq(shareLinks.token, token), eq(shareLinks.fileId, file.id)));
	if (!link) error(404, 'Share link not found');

	await db.update(shareLinks).set({ revokedAt: new Date(), revocationReason: 'owner' }).where(eq(shareLinks.id, link.id));

	await logAccess({ fileId: file.id, actorId: user.id, action: 'SHARE_REVOKE', success: true });
	return json({ ok: true });
};
