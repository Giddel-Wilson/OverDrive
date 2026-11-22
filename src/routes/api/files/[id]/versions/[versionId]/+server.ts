import { json } from '@sveltejs/kit';
import { requireUser } from '$server/auth';
import { parseBody } from '$server/validate';
import { versionRestoreSchema } from '$server/schemas';
import { ownedFileVersion, applyFileRevision } from '$server/versions';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const user = requireUser(locals);
	const body = parseBody(versionRestoreSchema, await request.json());
	await ownedFileVersion(params.id, params.versionId, user.id);
	return json(await applyFileRevision(user.id, params.id, body.baseVersion, { kind: 'version', id: params.versionId, metadata: body.metadata }));
};
