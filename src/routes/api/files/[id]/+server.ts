import { json, error } from '@sveltejs/kit';
import { eq, and, isNull } from 'drizzle-orm';
import { db, encryptedFiles, fileMetadata } from '$server/db';
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
	const { encryptedBlob, iv } = parseBody(metadataUpdateSchema, await request.json());

	const [file] = await db
		.select({ id: encryptedFiles.id })
		.from(encryptedFiles)
		.where(and(eq(encryptedFiles.id, params.id), eq(encryptedFiles.ownerId, user.id), isNull(encryptedFiles.deletedAt)));
	if (!file) error(404, 'File not found');

	await db.update(fileMetadata).set({ encryptedBlob, iv }).where(eq(fileMetadata.fileId, file.id));
	return json({ ok: true });
};
