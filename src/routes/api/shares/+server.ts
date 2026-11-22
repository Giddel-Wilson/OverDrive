import { json } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db, shareLinks, encryptedFiles, fileVersions, fileMetadata } from '$server/db';
import { requireUser } from '$server/auth';
import { fileRecord } from '$server/file-records';
import { autoRevokeLimitedLinks } from '$server/shared-files';
import type { RequestHandler } from './$types';

/** All of the owner's links, grouped by stable file id; names remain encrypted. */
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	await autoRevokeLimitedLinks({ ownerId: user.id });
	const rows = await db.select({
		id: shareLinks.id, token: shareLinks.token, fileId: shareLinks.fileId,
		maxDownloads: shareLinks.maxDownloads, downloadCount: shareLinks.downloadCount,
		expiresAt: shareLinks.expiresAt, revokedAt: shareLinks.revokedAt, createdAt: shareLinks.createdAt,
		revocationReason: shareLinks.revocationReason, downloadGrantUntil: shareLinks.downloadGrantUntil,
		versionNumber: sql<number | null>`CASE WHEN ${shareLinks.versionId} IS NULL AND ${shareLinks.createdAt} < ${encryptedFiles.contentUpdatedAt} THEN NULL ELSE coalesce(${fileVersions.versionNumber}, ${encryptedFiles.versionNumber}) END`,
		file: encryptedFiles, metadata: fileMetadata
	}).from(shareLinks).innerJoin(encryptedFiles, eq(encryptedFiles.id, shareLinks.fileId))
		.leftJoin(fileVersions, eq(fileVersions.id, shareLinks.versionId))
		.leftJoin(fileMetadata, eq(fileMetadata.fileId, encryptedFiles.id))
		.where(eq(encryptedFiles.ownerId, user.id)).orderBy(desc(shareLinks.createdAt));
	const files = new Map(rows.map((row) => [row.file.id, fileRecord(row.file, row.metadata)]));
	return json({
		files: [...files.values()],
		links: rows.map(({ file, metadata: _metadata, ...link }) => ({ ...link, fileInTrash: file.deletedAt !== null }))
	}, { headers: { 'Cache-Control': 'no-store' } });
};
