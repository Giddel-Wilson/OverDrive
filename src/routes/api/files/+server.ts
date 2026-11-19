import { json } from '@sveltejs/kit';
import { eq, and, isNull, isNotNull, desc } from 'drizzle-orm';
import { db, encryptedFiles, fileMetadata } from '$server/db';
import { requireUser } from '$server/auth';
import type { RequestHandler } from './$types';

/**
 * Returns the current user's files, with everything needed to decrypt
 * filenames and content client-side. No plaintext filename, mime type,
 * folder or key material in usable form ever appears here — the browser
 * decrypts `metadata.encryptedBlob` locally with the unlocked private key.
 *
 * ?view=active  (default) finished uploads that aren't in the trash
 * ?view=trash   finished uploads in the trash
 * ?view=pending uploads that were started but never finalized (resumable)
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals);
	const view = url.searchParams.get('view') ?? 'active';

	const stateFilter =
		view === 'trash'
			? and(eq(encryptedFiles.uploadStatus, 'complete'), isNotNull(encryptedFiles.deletedAt))
			: view === 'pending'
				? and(eq(encryptedFiles.uploadStatus, 'uploading'), isNull(encryptedFiles.deletedAt))
				: and(eq(encryptedFiles.uploadStatus, 'complete'), isNull(encryptedFiles.deletedAt));

	const rows = await db
		.select({
			id: encryptedFiles.id,
			fileAlgo: encryptedFiles.fileAlgo,
			fileIv: encryptedFiles.fileIv,
			keyAlgo: encryptedFiles.keyAlgo,
			wrappedFileKey: encryptedFiles.wrappedFileKey,
			keyWrapIv: encryptedFiles.keyWrapIv,
			keyWrapEphemeralPublicKeyJwk: encryptedFiles.keyWrapEphemeralPublicKeyJwk,
			totalChunks: encryptedFiles.totalChunks,
			chunkSizeBytes: encryptedFiles.chunkSizeBytes,
			ciphertextSizeBytes: encryptedFiles.ciphertextSizeBytes,
			ciphertextSha256: encryptedFiles.ciphertextSha256,
			uploadStatus: encryptedFiles.uploadStatus,
			createdAt: encryptedFiles.createdAt,
			deletedAt: encryptedFiles.deletedAt,
			metaBlob: fileMetadata.encryptedBlob,
			metaIv: fileMetadata.iv,
			metaAlgo: fileMetadata.algo,
			strengthLabel: fileMetadata.strengthLabel,
			strengthScore: fileMetadata.strengthScore
		})
		.from(encryptedFiles)
		.leftJoin(fileMetadata, eq(fileMetadata.fileId, encryptedFiles.id))
		.where(and(eq(encryptedFiles.ownerId, user.id), stateFilter))
		.orderBy(desc(encryptedFiles.createdAt));

	const files = rows.map((r) => ({
		id: r.id,
		fileAlgo: r.fileAlgo,
		fileIv: r.fileIv,
		keyAlgo: r.keyAlgo,
		wrappedFileKey: r.wrappedFileKey,
		keyWrapIv: r.keyWrapIv,
		keyWrapEphemeralPublicKeyJwk: r.keyWrapEphemeralPublicKeyJwk,
		totalChunks: r.totalChunks,
		chunkSizeBytes: r.chunkSizeBytes,
		ciphertextSizeBytes: r.ciphertextSizeBytes,
		ciphertextSha256: r.ciphertextSha256,
		uploadStatus: r.uploadStatus,
		createdAt: r.createdAt,
		deletedAt: r.deletedAt,
		metadata: r.metaBlob
			? { encryptedBlob: r.metaBlob, iv: r.metaIv, algo: r.metaAlgo, strengthLabel: r.strengthLabel, strengthScore: r.strengthScore }
			: null
	}));

	return json({ files });
};
