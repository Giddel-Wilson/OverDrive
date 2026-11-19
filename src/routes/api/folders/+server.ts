import { json } from '@sveltejs/kit';
import { and, eq, isNull, isNotNull, asc } from 'drizzle-orm';
import { db, folders } from '$server/db';
import { requireUser } from '$server/auth';
import { parseBody } from '$server/validate';
import { folderCreateSchema } from '$server/schemas';
import type { RequestHandler } from './$types';

/** ?view=active (default) or ?view=trash. Names and nesting are encrypted blobs. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals);
	const trashed = url.searchParams.get('view') === 'trash';

	const rows = await db
		.select()
		.from(folders)
		.where(and(eq(folders.ownerId, user.id), trashed ? isNotNull(folders.deletedAt) : isNull(folders.deletedAt)))
		.orderBy(asc(folders.createdAt));

	return json({
		folders: rows.map((f) => ({
			id: f.id,
			encryptedBlob: f.encryptedBlob,
			iv: f.iv,
			algo: f.algo,
			wrappedKey: f.wrappedKey,
			keyAlgo: f.keyAlgo,
			keyWrapIv: f.keyWrapIv,
			keyWrapEphemeralPublicKeyJwk: f.keyWrapEphemeralPublicKeyJwk,
			createdAt: f.createdAt,
			deletedAt: f.deletedAt
		}))
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = parseBody(folderCreateSchema, await request.json());

	const [row] = await db
		.insert(folders)
		.values({
			ownerId: user.id,
			encryptedBlob: body.encryptedBlob,
			iv: body.iv,
			algo: body.algo,
			wrappedKey: body.wrappedKey,
			keyAlgo: body.keyAlgo,
			keyWrapIv: body.keyWrapIv ?? null,
			keyWrapEphemeralPublicKeyJwk: body.keyWrapEphemeralPublicKeyJwk ?? null
		})
		.returning({ id: folders.id });

	return json({ id: row.id });
};
