import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, encryptedFiles, fileVersions } from './db';
import { filesStore, contentPrefix } from './blob-store';

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
	const rows = await db.select({ id: encryptedFiles.id, ownerId: encryptedFiles.ownerId, storageKey: encryptedFiles.storageKey }).from(encryptedFiles).where(and(...conditions));

	const store = filesStore();
	const purged: string[] = [];
	const failed: string[] = [];

	for (const row of rows) {
		const { id } = row;
		try {
			const versions = await db.select({ storageKey: fileVersions.storageKey }).from(fileVersions).where(eq(fileVersions.fileId, id));
			const pending = await db.select({ id: encryptedFiles.id, ownerId: encryptedFiles.ownerId, storageKey: encryptedFiles.storageKey }).from(encryptedFiles).where(and(eq(encryptedFiles.replacesFileId, id), eq(encryptedFiles.ownerId, ownerId)));
			const prefixes = new Set([contentPrefix(row), ...versions.map((v) => `${v.storageKey}/`), ...pending.map(contentPrefix)]);
			const keys = new Set<string>();
			for (const prefix of prefixes) for (const object of await store.list(prefix)) keys.add(object.key);
			const { failed: keysFailed } = await store.deleteMany([...keys]);
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
