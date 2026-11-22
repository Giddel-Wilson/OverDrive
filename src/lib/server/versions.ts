import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db, encryptedFiles, fileVersions, runTransaction } from './db';
import { filesStore } from './blob-store';
import { MAX_FILE_VERSIONS } from '$lib/shared/limits';
import type { EncryptedFileRecord } from '$crypto/download-pipeline';

const contentColumns = [
	'storage_key', 'storage_provider', 'ciphertext_size_bytes', 'file_algo', 'file_iv', 'file_auth_tag',
	'chunked', 'chunk_size_bytes', 'wrapped_file_key', 'key_algo', 'key_wrap_iv',
	'key_wrap_ephemeral_public_key_jwk', 'total_chunks', 'ciphertext_sha256',
	'thumbnail_iv', 'thumbnail_sha256', 'thumbnail_size_bytes'
];
const columns = sql.raw(contentColumns.join(', '));
const currentColumns = sql.raw(contentColumns.map((name) => `f.${name}`).join(', '));
const assignments = sql.raw(contentColumns.map((name) => `${name} = s.${name}`).join(', '));

export async function ownedCurrentFile(fileId: string, ownerId: string) {
	const [file] = await db.select().from(encryptedFiles).where(and(
		eq(encryptedFiles.id, fileId), eq(encryptedFiles.ownerId, ownerId), isNull(encryptedFiles.deletedAt),
		eq(encryptedFiles.uploadStatus, 'complete'), isNull(encryptedFiles.replacesFileId)
	));
	if (!file) error(404, 'File not found');
	return file;
}

export async function ownedFileVersion(fileId: string, versionId: string, ownerId: string) {
	const file = await ownedCurrentFile(fileId, ownerId);
	const [version] = await db.select().from(fileVersions).where(and(
		eq(fileVersions.id, versionId), eq(fileVersions.fileId, file.id), isNull(fileVersions.purgingAt)
	));
	if (!version) error(404, 'Version not found');
	return { file, version };
}

export function versionRecord(version: typeof fileVersions.$inferSelect): EncryptedFileRecord {
	return {
		id: version.id, versionOf: version.fileId, versionNumber: version.versionNumber,
		fileAlgo: version.fileAlgo, fileIv: version.fileIv, keyAlgo: version.keyAlgo,
		wrappedFileKey: version.wrappedFileKey, keyWrapIv: version.keyWrapIv,
		keyWrapEphemeralPublicKeyJwk: version.keyWrapEphemeralPublicKeyJwk as JsonWebKey | null,
		totalChunks: version.totalChunks, chunkSizeBytes: version.chunkSizeBytes,
		ciphertextSha256: version.ciphertextSha256, ciphertextSizeBytes: version.ciphertextSizeBytes,
		createdAt: version.createdAt.toISOString(), archivedAt: version.archivedAt.toISOString(), uploadStatus: 'complete',
		thumbnail: version.thumbnailIv && version.thumbnailSha256 ? { iv: version.thumbnailIv, ciphertextSha256: version.thumbnailSha256, sizeBytes: version.thumbnailSizeBytes } : null,
		metadata: { encryptedBlob: version.metadataBlob, iv: version.metadataIv, algo: version.metadataAlgo, strengthLabel: version.strengthLabel }
	};
}

type RevisionSource =
	| { kind: 'upload'; id: string; ciphertextSha256: string }
	| { kind: 'version'; id: string; metadata: { encryptedBlob: string; iv: string } };

/**
 * Atomically archive current content, pin its shares, and promote a verified
 * upload or restore a retained revision. The expected revision rejects stale
 * overwrites. Both source and destination are locked until the batch commits.
 */
export async function applyFileRevision(ownerId: string, fileId: string, baseVersion: number, source: RevisionSource) {
	const archiveId = randomUUID();
	const currentGuard = sql`f.id = ${fileId} AND f.owner_id = ${ownerId} AND f.version_number = ${baseVersion}
		AND f.deleted_at IS NULL AND f.upload_status = 'complete' AND f.replaces_file_id IS NULL`;
	let sourceQuery;
	let sourceLock;
	if (source.kind === 'upload') {
		const selected = sql.join(contentColumns.map((name) => {
			if (name === 'storage_key') return sql`${`${ownerId}/${source.id}`}::text AS storage_key`;
			if (name === 'ciphertext_sha256') return sql`${source.ciphertextSha256}::text AS ciphertext_sha256`;
			return sql.raw(`p.${name}`);
		}), sql`, `);
		const guard = sql`p.id = ${source.id} AND p.owner_id = ${ownerId} AND p.replaces_file_id = ${fileId}
			AND p.base_version = ${baseVersion} AND p.upload_status = 'uploading' AND p.deleted_at IS NULL`;
		sourceQuery = sql`SELECT ${selected}, m.encrypted_blob AS metadata_blob, m.iv AS metadata_iv, m.algo AS metadata_algo,
			m.strength_score, m.strength_label FROM encrypted_files p JOIN file_metadata m ON m.file_id = p.id WHERE ${guard}`;
		sourceLock = sql`SELECT p.id FROM encrypted_files p WHERE ${guard} FOR UPDATE`;
	} else {
		sourceQuery = sql`SELECT ${columns}, metadata_blob, metadata_iv, metadata_algo, strength_score, strength_label
			FROM file_versions WHERE id = ${source.id} AND file_id = ${fileId} AND purging_at IS NULL`;
		sourceLock = sql`SELECT id FROM file_versions WHERE id = ${source.id} AND file_id = ${fileId} AND purging_at IS NULL FOR UPDATE`;
	}
	const saved = sql`EXISTS (SELECT 1 FROM file_versions WHERE id = ${archiveId})`;
	const results = await runTransaction([
		sql`SELECT f.id FROM encrypted_files f WHERE ${currentGuard} FOR UPDATE`,
		sourceLock,
		sql`INSERT INTO file_versions (id, file_id, version_number, ${columns}, metadata_blob, metadata_iv, metadata_algo, strength_score, strength_label, created_at)
			SELECT ${archiveId}, f.id, f.version_number, ${currentColumns}, m.encrypted_blob, m.iv, m.algo, m.strength_score, m.strength_label,
			CASE WHEN f.version_number = 1 THEN f.created_at ELSE f.content_updated_at END
			FROM encrypted_files f JOIN file_metadata m ON m.file_id = f.id WHERE ${currentGuard} AND EXISTS (${sourceQuery}) RETURNING id`,
		sql`UPDATE share_links SET version_id = ${archiveId} WHERE file_id = ${fileId} AND version_id IS NULL AND ${saved}`,
		sql`UPDATE file_metadata m SET encrypted_blob = ${source.kind === 'version' ? sql`${source.metadata.encryptedBlob}` : sql`s.metadata_blob`},
			iv = ${source.kind === 'version' ? sql`${source.metadata.iv}` : sql`s.metadata_iv`}, algo = s.metadata_algo,
			strength_score = s.strength_score, strength_label = s.strength_label FROM (${sourceQuery}) s WHERE m.file_id = ${fileId} AND ${saved}`,
		sql`UPDATE encrypted_files f SET ${assignments}, version_number = ${baseVersion + 1}, content_updated_at = now()
			FROM (${sourceQuery}) s WHERE ${currentGuard} AND ${saved} RETURNING f.id`,
		...(source.kind === 'upload' ? [sql`DELETE FROM encrypted_files p WHERE p.id = ${source.id} AND ${saved}
			AND EXISTS (SELECT 1 FROM encrypted_files f WHERE f.id = ${fileId} AND f.version_number = ${baseVersion + 1} AND f.storage_key = ${`${ownerId}/${source.id}`})`] : [])
	]);
	if (results[5].length === 0) error(409, 'This file changed while you were working. Refresh its version history before trying again.');
	// A storage outage must not undo a successful replacement. Cleanup retries pruning.
	let pruneFailed = 0;
	try { pruneFailed = (await pruneFileVersions(ownerId, fileId)).failed; } catch { pruneFailed = 1; }
	return { fileId, versionNumber: baseVersion + 1, pruneFailed };
}

/** Removes oldest unpinned revisions only after their objects have been deleted. */
export async function pruneFileVersions(ownerId: string, fileId: string): Promise<{ pruned: number; failed: number }> {
	const deadline = Date.now() + 10_000;
	const versions = await db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId)).orderBy(desc(fileVersions.versionNumber));
	const candidates = versions.filter((v, index) => index >= MAX_FILE_VERSIONS - 1 || v.purgingAt !== null);
	const store = filesStore();
	let pruned = 0;
	let failed = 0;
	for (const version of candidates) {
		if (Date.now() >= deadline) break;
		const claimed = await runTransaction([
			sql`SELECT id FROM encrypted_files WHERE id = ${fileId} AND owner_id = ${ownerId} FOR UPDATE`,
			sql`UPDATE file_versions v SET purging_at = COALESCE(purging_at, now()) WHERE v.id = ${version.id}
				AND EXISTS (SELECT 1 FROM encrypted_files f WHERE f.id = v.file_id AND f.owner_id = ${ownerId})
				AND NOT EXISTS (SELECT 1 FROM share_links l WHERE l.version_id = v.id
					AND (l.expires_at IS NULL OR l.expires_at > now())
					AND ((l.revoked_at IS NULL AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads OR l.download_grant_until > now()))
						OR (l.revocation_reason = 'download_limit' AND l.download_grant_until > now()))) RETURNING v.id`
		]);
		if (claimed[1].length === 0) continue;
		try {
			const [current] = await db.select({ storageKey: encryptedFiles.storageKey }).from(encryptedFiles).where(eq(encryptedFiles.id, fileId));
			const other = await db.select({ id: fileVersions.id }).from(fileVersions).where(and(eq(fileVersions.storageKey, version.storageKey), ne(fileVersions.id, version.id))).limit(1);
			// Restores can reuse an existing ciphertext pointer. Never remove shared objects.
			if (current?.storageKey !== version.storageKey && other.length === 0) {
				const objects = await store.list(`${version.storageKey}/`);
				const deletion = await store.deleteMany(objects.map((o) => o.key));
				if (deletion.failed.length) { failed++; continue; }
			}
			await db.delete(fileVersions).where(and(eq(fileVersions.id, version.id), sql`${fileVersions.purgingAt} IS NOT NULL`));
			pruned++;
		} catch { failed++; }
	}
	return { pruned, failed };
}
