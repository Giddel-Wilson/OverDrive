import { json, error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db, folders } from '$server/db';
import { requireUser } from '$server/auth';
import { parseBody } from '$server/validate';
import { metadataUpdateSchema } from '$server/schemas';
import type { RequestHandler } from './$types';

/** Rename / move a folder: replaces its encrypted blob (re-encrypted client-side). */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const user = requireUser(locals);
	const { encryptedBlob, iv } = parseBody(metadataUpdateSchema, await request.json());

	const updated = await db
		.update(folders)
		.set({ encryptedBlob, iv })
		.where(and(eq(folders.id, params.id), eq(folders.ownerId, user.id), isNull(folders.deletedAt)))
		.returning({ id: folders.id });
	if (updated.length === 0) error(404, 'Folder not found');

	return json({ ok: true });
};
