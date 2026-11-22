import { json, error } from '@sveltejs/kit';
import { eq, and, isNull } from 'drizzle-orm';
import { db, encryptedFiles, fileVersions, fileMetadata } from '$server/db';
import { requireUser } from '$server/auth';
import { logAccess } from '$server/access-log';
import { filesStore, sha256Hex, chunkKey, chunkPrefix } from '$server/blob-store';
import { parseBody } from '$server/validate';
import { uploadInitSchema, uploadFinalizeSchema, uploadPresignSchema } from '$server/schemas';
import { purgeFiles } from '$server/files';
import { assertWithinQuota } from '$server/quota';
import { MAX_FILE_SIZE_BYTES } from '$lib/shared/limits';
import { CHUNK_SIZE_BYTES } from '$crypto/types';
import { ownedCurrentFile, applyFileRevision } from '$server/versions';
import { thumbnailBytes, storeThumbnail } from '$server/thumbnails';
import type { RequestHandler } from './$types';

/** Loads an upload the caller owns that hasn't been finalized (or 404s). */
async function ownedPendingUpload(fileId: string, userId: string) {
	const [file] = await db
		.select()
		.from(encryptedFiles)
		.where(and(eq(encryptedFiles.id, fileId), eq(encryptedFiles.ownerId, userId), isNull(encryptedFiles.deletedAt)));
	if (!file) error(404, 'Upload not found');
	return file;
}

/** A promoted upload no longer has its temporary row, but its immutable pointer remains. */
async function completedUpload(fileId: string, userId: string) {
	const pointer = `${userId}/${fileId}`;
	const [current] = await db.select({ fileId: encryptedFiles.id, versionNumber: encryptedFiles.versionNumber, totalChunks: encryptedFiles.totalChunks, sha256: encryptedFiles.ciphertextSha256 })
		.from(encryptedFiles).where(and(eq(encryptedFiles.ownerId, userId), eq(encryptedFiles.storageKey, pointer), eq(encryptedFiles.uploadStatus, 'complete'), isNull(encryptedFiles.deletedAt)));
	if (current) return current;
	const [retained] = await db.select({ fileId: fileVersions.fileId, versionNumber: fileVersions.versionNumber, totalChunks: fileVersions.totalChunks, sha256: fileVersions.ciphertextSha256 })
		.from(fileVersions).innerJoin(encryptedFiles, eq(encryptedFiles.id, fileVersions.fileId))
		.where(and(eq(encryptedFiles.ownerId, userId), eq(fileVersions.storageKey, pointer), isNull(encryptedFiles.deletedAt)));
	return retained;
}

/** chunk-N object keys under a file's prefix → sorted list of N. */
function indexesFromKeys(prefix: string, keys: { key: string; size: number }[]) {
	const out = new Map<number, number>(); // index -> size
	for (const { key, size } of keys) {
		const m = /^chunk-(\d+)$/.exec(key.slice(prefix.length));
		if (m) out.set(Number(m[1]), size);
	}
	return out;
}

/**
 * Upload protocol (the browser sends ciphertext straight to object
 * storage; this route only coordinates):
 *
 *   POST {action:'init'}      create the file row (status 'uploading')
 *   POST {action:'presign'}   get presigned PUT URLs for chunk indexes
 *   GET  ?fileId=             which chunks already exist (resume)
 *   POST {action:'finalize'}  verify every chunk is present, mark complete
 *   DELETE ?fileId=           abandon an unfinished upload
 *   PUT  (headers)            fallback relay when direct upload is blocked
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);
	const rawBody = await request.json();

	if (rawBody.action === 'init') {
		const body = parseBody(uploadInitSchema, rawBody);
		if (Boolean(body.replacesFileId) !== Boolean(body.baseVersion)) error(400, 'A replacement needs both a file id and its current version number');
		if (body.replacesFileId) {
			const current = await ownedCurrentFile(body.replacesFileId, user.id);
			if (current.versionNumber !== body.baseVersion) error(409, 'This file has a newer version. Refresh before replacing it.');
		}
		const thumbnail = body.thumbnail ? await thumbnailBytes(body.thumbnail) : null;

		// Defense in depth — the client already checks this before
		// encrypting, but a client can't be trusted to enforce its own
		// limits, so it's re-checked here against the declared size.
		if (body.ciphertextSizeBytesEstimate > MAX_FILE_SIZE_BYTES + body.totalChunks * 16) {
			error(413, `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024 * 1024)} GB limit`);
		}

		// Storage limit (default or per-user override). Cheap, and done before
		// any row is created or any chunk is encrypted and sent.
		await assertWithinQuota(user.id, body.ciphertextSizeBytesEstimate + (thumbnail?.length ?? 0));

		const [row] = await db
			.insert(encryptedFiles)
			.values({
				ownerId: user.id,
				storageKey: '', // set on finalize
				ciphertextSizeBytes: body.ciphertextSizeBytesEstimate,
				fileAlgo: body.fileAlgo,
				fileIv: body.fileIv,
				chunkSizeBytes: body.chunkSizeBytes ?? CHUNK_SIZE_BYTES,
				wrappedFileKey: body.wrappedFileKey,
				keyAlgo: body.keyAlgo,
				keyWrapIv: body.wrapIv ?? null,
				keyWrapEphemeralPublicKeyJwk: body.ephemeralPublicKeyJwk ?? null,
				totalChunks: body.totalChunks,
				ciphertextSha256: '', // set on finalize
				uploadStatus: 'uploading',
				replacesFileId: body.replacesFileId ?? null,
				baseVersion: body.baseVersion ?? null,
				thumbnailIv: body.thumbnail?.iv ?? null,
				thumbnailSha256: body.thumbnail?.ciphertextSha256 ?? null,
				thumbnailSizeBytes: thumbnail?.length ?? 0
			})
			.returning({ id: encryptedFiles.id });

		await db.insert(fileMetadata).values({
			fileId: row.id,
			encryptedBlob: body.metadata.encryptedBlob,
			iv: body.metadata.iv,
			algo: body.metadata.algo,
			strengthScore: body.metadata.strengthScore,
			strengthLabel: body.metadata.strengthLabel
		});
		if (body.thumbnail && thumbnail) {
			try { await storeThumbnail(chunkPrefix(user.id, row.id), body.thumbnail, thumbnail); }
			catch (err) { await purgeFiles(user.id, [row.id], { onlyTrashed: false }); throw err; }
		}

		return json({ fileId: row.id });
	}

	if (rawBody.action === 'presign') {
		const { fileId, indexes } = parseBody(uploadPresignSchema, rawBody);
		const file = await ownedPendingUpload(fileId, user.id);
		if (file.uploadStatus !== 'uploading') error(409, 'This upload is already finalized');
		if (indexes.some((i) => i >= file.totalChunks)) error(400, 'Chunk index out of range');

		const store = filesStore();
		const entries = await Promise.all(
			indexes.map(async (i) => [i, await store.presignPut(chunkKey(user.id, file.id, i))] as const)
		);
		return json({ urls: Object.fromEntries(entries) });
	}

	if (rawBody.action === 'finalize') {
		const { fileId, ciphertextSha256 } = parseBody(uploadFinalizeSchema, rawBody);
		const completed = await completedUpload(fileId, user.id);
		if (completed) {
			if (completed.sha256 !== ciphertextSha256) error(409, 'This completed upload has a different integrity hash');
			return json({ ok: true, fileId: completed.fileId, versionNumber: completed.versionNumber });
		}
		const file = await ownedPendingUpload(fileId, user.id);
		if (file.uploadStatus === 'complete') return json({ ok: true }); // idempotent

		// The server can't read ciphertext it didn't relay, so verify what it
		// CAN: every chunk object exists and the total size matches what the
		// client declared at init. Content integrity is covered end to end —
		// the AEAD tag on every chunk plus the client's SHA-256 over the whole
		// ciphertext, re-checked on every download.
		const prefix = chunkPrefix(user.id, file.id);
		const present = indexesFromKeys(prefix, await filesStore().list(prefix));
		const missing: number[] = [];
		let total = 0;
		for (let i = 0; i < file.totalChunks; i++) {
			const size = present.get(i);
			if (size === undefined) missing.push(i);
			else total += size;
		}
		if (missing.length > 0) {
			return json({ message: `${missing.length} chunk(s) never reached storage`, missing: missing.slice(0, 100) }, { status: 409 });
		}
		if (total !== file.ciphertextSizeBytes) {
			return json({ message: 'Stored ciphertext size does not match what was declared', expected: file.ciphertextSizeBytes, actual: total }, { status: 409 });
		}

		if (file.replacesFileId) {
			return json(await applyFileRevision(user.id, file.replacesFileId, file.baseVersion!, { kind: 'upload', id: file.id, ciphertextSha256 }));
		}

		await db
			.update(encryptedFiles)
			.set({ ciphertextSha256, storageKey: `${user.id}/${file.id}`, uploadStatus: 'complete' })
			.where(and(eq(encryptedFiles.id, file.id), eq(encryptedFiles.uploadStatus, 'uploading'), isNull(encryptedFiles.deletedAt)));
		await logAccess({ fileId: file.id, actorId: user.id, action: 'UPLOAD', success: true });
		return json({ ok: true });
	}

	error(400, 'Unknown action');
};

/** Which chunks of a pending upload already exist in storage (drives resume). */
export const GET: RequestHandler = async ({ url, locals }) => {
	const user = requireUser(locals);
	const fileId = url.searchParams.get('fileId');
	if (!fileId) error(400, 'Missing fileId');
	const completed = await completedUpload(fileId, user.id);
	if (completed) return json({ status: 'complete', fileId: completed.fileId, totalChunks: completed.totalChunks, uploaded: Array.from({ length: completed.totalChunks }, (_, index) => index) });

	const file = await ownedPendingUpload(fileId, user.id);
	const prefix = chunkPrefix(user.id, file.id);
	const present = indexesFromKeys(prefix, await filesStore().list(prefix));

	return json({
		status: file.uploadStatus,
		totalChunks: file.totalChunks,
		uploaded: [...present.keys()].filter((i) => i < file.totalChunks).sort((a, b) => a - b)
	});
};

/** Abandon an unfinished upload: deletes whatever chunks landed, then the row. */
export const DELETE: RequestHandler = async ({ url, locals }) => {
	const user = requireUser(locals);
	const fileId = url.searchParams.get('fileId');
	if (!fileId) error(400, 'Missing fileId');

	const file = await ownedPendingUpload(fileId, user.id);
	if (file.uploadStatus !== 'uploading') error(409, 'Only unfinished uploads can be discarded here — use the trash');

	const { failed } = await purgeFiles(user.id, [file.id], { onlyTrashed: false });
	if (failed.length > 0) error(502, 'Could not remove all uploaded chunks — try again');
	return json({ ok: true });
};

/**
 * Fallback relay. The normal path is a direct browser → storage PUT to a
 * presigned URL; if that's blocked (bucket CORS not configured yet, or a
 * restrictive network), the client falls back to sending each chunk
 * through here instead. Chunks arrive as base64 inside JSON, and the
 * server reads back what storage persisted and compares hashes before
 * acknowledging.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);
	const fileId = request.headers.get('X-File-Id');
	const chunkIndex = Number(request.headers.get('X-Chunk-Index') ?? '0');
	if (!fileId) error(400, 'Missing X-File-Id');
	if (!Number.isInteger(chunkIndex) || chunkIndex < 0) error(400, 'Invalid X-Chunk-Index');

	const file = await ownedPendingUpload(fileId, user.id);
	if (file.uploadStatus !== 'uploading') error(409, 'This upload is already finalized');
	if (chunkIndex >= file.totalChunks) error(400, 'Chunk index out of range');

	const { chunk } = await request.json();
	const ciphertext = new Uint8Array(Buffer.from(chunk, 'base64'));

	const store = filesStore();
	const key = chunkKey(user.id, file.id, chunkIndex);
	await store.set(key, ciphertext.buffer as ArrayBuffer);

	const readBack = await store.get(key, { type: 'arrayBuffer' });
	const sentHash = await sha256Hex(ciphertext);
	const storedHash = readBack ? await sha256Hex(new Uint8Array(readBack)) : null;
	if (!readBack || storedHash !== sentHash) {
		await store.delete(key).catch(() => {});
		error(502, `Chunk ${chunkIndex} did not store correctly — please retry the upload`);
	}

	return json({ ok: true });
};
