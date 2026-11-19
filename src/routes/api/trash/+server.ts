import { json } from '@sveltejs/kit';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { db, encryptedFiles, folders, accessLogs } from '$server/db';
import { requireUser } from '$server/auth';
import { parseBody } from '$server/validate';
import { trashSchema } from '$server/schemas';
import { purgeFiles } from '$server/files';
import type { RequestHandler } from './$types';

/**
 * Batch trash / restore / permanent delete for files and folders. The
 * browser works out which descendants belong with a folder (it's the only
 * party that can read the folder tree) and sends the full id lists.
 */
export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const user = requireUser(locals);
	const { action, fileIds, folderIds } = parseBody(trashSchema, await request.json());

	if (action === 'trash') {
		const files = fileIds.length
			? await db
					.update(encryptedFiles)
					.set({ deletedAt: new Date() })
					.where(and(eq(encryptedFiles.ownerId, user.id), inArray(encryptedFiles.id, fileIds), isNull(encryptedFiles.deletedAt)))
					.returning({ id: encryptedFiles.id })
			: [];
		const dirs = folderIds.length
			? await db
					.update(folders)
					.set({ deletedAt: new Date() })
					.where(and(eq(folders.ownerId, user.id), inArray(folders.id, folderIds), isNull(folders.deletedAt)))
					.returning({ id: folders.id })
			: [];
		if (files.length > 0) {
			await db.insert(accessLogs).values(
				files.map((f) => ({ fileId: f.id, actorId: user.id, action: 'DELETE' as const, success: true, ipAddress: getClientAddress() }))
			);
		}
		return json({ ok: true, files: files.length, folders: dirs.length });
	}

	if (action === 'restore') {
		const files = fileIds.length
			? await db
					.update(encryptedFiles)
					.set({ deletedAt: null })
					.where(and(eq(encryptedFiles.ownerId, user.id), inArray(encryptedFiles.id, fileIds), isNotNull(encryptedFiles.deletedAt)))
					.returning({ id: encryptedFiles.id })
			: [];
		const dirs = folderIds.length
			? await db
					.update(folders)
					.set({ deletedAt: null })
					.where(and(eq(folders.ownerId, user.id), inArray(folders.id, folderIds), isNotNull(folders.deletedAt)))
					.returning({ id: folders.id })
			: [];
		return json({ ok: true, files: files.length, folders: dirs.length });
	}

	// purge — permanent
	const { purged, failed } = await purgeFiles(user.id, fileIds, { onlyTrashed: true });
	if (purged.length > 0) {
		// Log with fileId null: the rows are already gone, and the FK would reject a dangling id.
		await db.insert(accessLogs).values(
			purged.map(() => ({ actorId: user.id, action: 'DELETE' as const, success: true, failureReason: 'purged', ipAddress: getClientAddress() }))
		);
	}
	const removedFolders = folderIds.length
		? await db
				.delete(folders)
				.where(and(eq(folders.ownerId, user.id), inArray(folders.id, folderIds), isNotNull(folders.deletedAt)))
				.returning({ id: folders.id })
		: [];

	return json({ ok: failed.length === 0, files: purged.length, folders: removedFolders.length, failed });
};
