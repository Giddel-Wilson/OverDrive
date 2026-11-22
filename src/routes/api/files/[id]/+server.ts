import { json, error } from '@sveltejs/kit';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db, encryptedFiles, runTransaction } from '$server/db';
import { requireUser } from '$server/auth';
import { logAccess } from '$server/access-log';
import { parseBody } from '$server/validate';
import { metadataUpdateSchema } from '$server/schemas';
import type { RequestHandler } from './$types';

/**
 * Moves a file to the trash. Nothing is removed from object storage here —
 * that only happens on permanent delete (POST /api/trash, action "purge"),
 * so a trashed file can still be restored.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals);

	const [file] = await db
		.select({ id: encryptedFiles.id })
		.from(encryptedFiles)
		.where(and(eq(encryptedFiles.id, params.id), eq(encryptedFiles.ownerId, user.id), isNull(encryptedFiles.deletedAt)));
	if (!file) error(404, 'File not found');

	await db.update(encryptedFiles).set({ deletedAt: new Date() }).where(eq(encryptedFiles.id, file.id));
	await logAccess({ fileId: file.id, actorId: user.id, action: 'DELETE', success: true });

	return json({ ok: true });
};

/**
 * Replaces the encrypted metadata blob — used for rename and move. The
 * browser decrypts the old blob, edits it, re-encrypts it under the file's
 * own key, and sends only the new ciphertext. The server can't tell a
 * rename from a move from a no-op.
 */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const user = requireUser(locals);
	const { encryptedBlob, iv, versionNumber } = parseBody(metadataUpdateSchema, await request.json());

	const [file] = await db
		.select({ id: encryptedFiles.id })
		.from(encryptedFiles)
		.where(and(eq(encryptedFiles.id, params.id), eq(encryptedFiles.ownerId, user.id), isNull(encryptedFiles.deletedAt)));
	if (!file) error(404, 'File not found');

	const guard = sql`id = ${file.id} AND owner_id = ${user.id} AND version_number = ${versionNumber} AND deleted_at IS NULL AND upload_status = 'complete'`;
	const result = await runTransaction([
		sql`SELECT id FROM encrypted_files WHERE ${guard} FOR UPDATE`,
		sql`UPDATE file_metadata SET encrypted_blob = ${encryptedBlob}, iv = ${iv} WHERE file_id = ${file.id}
			AND EXISTS (SELECT 1 FROM encrypted_files WHERE ${guard}) RETURNING file_id`
	]);
	if (result[1].length === 0) error(409, 'This file changed. Refresh before renaming or moving it.');
	return json({ ok: true });
};
