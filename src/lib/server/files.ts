import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, encryptedFiles } from './db';
import { filesStore, chunkPrefix } from './blob-store';

/**
 * Permanently deletes files the user owns: removes every ciphertext object
 * from storage first, and only deletes the DB row (which cascades to
 * metadata and share links) once the blobs are confirmed gone — so a
 * failed storage call leaves a retryable row instead of an orphaned,
 * invisible-but-billed blob.
 *
 * `onlyTrashed` guards the normal "empty trash" path against purging a
 * live file by id; upload-abort passes false for its own pending rows.
 */
export async function purgeFiles(
	ownerId: string,
	fileIds: string[],
	opts: { onlyTrashed: boolean }
): Promise<{ purged: string[]; failed: string[] }> {
	if (fileIds.length === 0) return { purged: [], failed: [] };

	const conditions = [eq(encryptedFiles.ownerId, ownerId), inArray(encryptedFiles.id, fileIds)];
	if (opts.onlyTrashed) conditions.push(isNotNull(encryptedFiles.deletedAt));
	const rows = await db.select({ id: encryptedFiles.id }).from(encryptedFiles).where(and(...conditions));

	const store = filesStore();
	const purged: string[] = [];
	const failed: string[] = [];

	for (const { id } of rows) {
		try {
			const objects = await store.list(chunkPrefix(ownerId, id));
			const { failed: keysFailed } = await store.deleteMany(objects.map((o) => o.key));
			if (keysFailed.length > 0) {
				failed.push(id);
				continue;
			}
			purged.push(id);
		} catch {
			failed.push(id);
		}
	}

	if (purged.length > 0) {
		await db.delete(encryptedFiles).where(and(eq(encryptedFiles.ownerId, ownerId), inArray(encryptedFiles.id, purged)));
	}
	return { purged, failed };
}
