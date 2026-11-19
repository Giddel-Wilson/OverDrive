/**
 * Hard cap on individual file size, enforced on both the client (before
 * encryption starts) and the server (at upload init, defense in depth).
 *
 * Uploads go straight from the browser to object storage through
 * presigned URLs (see crypto/upload-pipeline.ts), so Vercel's 4.5 MB body
 * limit no longer constrains file size. The cap that remains is purely a
 * cost/abuse guard for a multi-user deployment — raise or remove it for a
 * personal vault.
 */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

/** Chunks uploaded to object storage in parallel (bounds browser memory too). */
export const UPLOAD_CONCURRENCY = 4;

/** Presigned URLs requested per round trip. */
export const PRESIGN_BATCH_SIZE = 32;

/** Lifetime of a presigned upload URL. */
export const PRESIGN_EXPIRES_SECONDS = 60 * 60;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
