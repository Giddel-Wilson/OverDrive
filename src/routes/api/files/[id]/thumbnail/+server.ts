import { error, json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db, encryptedFiles, fileVersions } from '$server/db';
import { requireUser } from '$server/auth';
import { ownedCurrentFile } from '$server/versions';
import { contentPrefix, filesStore, thumbnailKey } from '$server/blob-store';
import { parseBody } from '$server/validate';
import { thumbnailUpdateSchema } from '$server/schemas';
import { thumbnailBytes, storeThumbnail } from '$server/thumbnails';
import { assertWithinQuota } from '$server/quota';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const user = requireUser(locals);
	const file = await ownedCurrentFile(params.id, user.id);
	const revision = url.searchParams.get('revision');
	if (revision && Number(revision) !== file.versionNumber) error(409, 'The file changed. Refresh its thumbnail.');
	if (!file.thumbnailIv || !file.thumbnailSha256) error(404, 'No thumbnail for this file');
	const bytes = await filesStore().get(thumbnailKey(contentPrefix(file), file.thumbnailSha256));
	if (!bytes) error(404, 'Thumbnail not found');
	return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
};

/** Backfill a legacy photo once. Ciphertext only, with a revision compare-and-set. */
export const PUT: RequestHandler = async ({ params, locals, request }) => {
	const user = requireUser(locals);
	const { versionNumber, thumbnail } = parseBody(thumbnailUpdateSchema, await request.json());
	const file = await ownedCurrentFile(params.id, user.id);
	if (versionNumber !== file.versionNumber) error(409, 'The file changed. Refresh before making a thumbnail.');
	if (file.thumbnailIv) return json({ ok: true });
	const bytes = await thumbnailBytes(thumbnail);
	await assertWithinQuota(user.id, bytes.length);
	const prefix = contentPrefix(file);
	await storeThumbnail(prefix, thumbnail, bytes);
	const [updated] = await db.update(encryptedFiles).set({ thumbnailIv: thumbnail.iv, thumbnailSha256: thumbnail.ciphertextSha256, thumbnailSizeBytes: bytes.length })
		.where(and(eq(encryptedFiles.id, file.id), eq(encryptedFiles.versionNumber, versionNumber), isNull(encryptedFiles.thumbnailIv), isNull(encryptedFiles.deletedAt))).returning({ id: encryptedFiles.id });
	if (!updated) {
		const [current] = await db.select().from(encryptedFiles).where(eq(encryptedFiles.id, file.id));
		const references = await db.select({ id: fileVersions.id }).from(fileVersions).where(and(eq(fileVersions.storageKey, file.storageKey), eq(fileVersions.thumbnailSha256, thumbnail.ciphertextSha256))).limit(1);
		if (!(current?.storageKey === file.storageKey && current.thumbnailSha256 === thumbnail.ciphertextSha256) && references.length === 0) {
			await filesStore().delete(thumbnailKey(prefix, thumbnail.ciphertextSha256)).catch(() => {});
		}
		error(409, 'The file changed while its thumbnail was being saved. Refresh and try again.');
	}
	return json({ ok: true });
};
