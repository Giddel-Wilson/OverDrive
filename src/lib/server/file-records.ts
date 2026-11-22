import type { encryptedFiles, fileMetadata } from './db/schema';
import type { EncryptedFileRecord } from '$crypto/download-pipeline';

export function fileRecord(file: typeof encryptedFiles.$inferSelect, metadata: typeof fileMetadata.$inferSelect | null): EncryptedFileRecord {
	return {
		id: file.id, fileAlgo: file.fileAlgo, fileIv: file.fileIv, keyAlgo: file.keyAlgo,
		wrappedFileKey: file.wrappedFileKey, keyWrapIv: file.keyWrapIv,
		keyWrapEphemeralPublicKeyJwk: file.keyWrapEphemeralPublicKeyJwk as JsonWebKey | null,
		totalChunks: file.totalChunks, chunkSizeBytes: file.chunkSizeBytes,
		ciphertextSha256: file.ciphertextSha256, ciphertextSizeBytes: file.ciphertextSizeBytes,
		versionNumber: file.versionNumber, createdAt: file.createdAt.toISOString(), contentUpdatedAt: file.contentUpdatedAt.toISOString(),
		deletedAt: file.deletedAt?.toISOString() ?? null,
		metadata: metadata ? { encryptedBlob: metadata.encryptedBlob, iv: metadata.iv, algo: metadata.algo, strengthLabel: metadata.strengthLabel } : null,
		thumbnail: file.thumbnailIv && file.thumbnailSha256 ? { iv: file.thumbnailIv, ciphertextSha256: file.thumbnailSha256, sizeBytes: file.thumbnailSizeBytes } : null
	};
}
