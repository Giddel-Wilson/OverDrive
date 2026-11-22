import { error, json } from '@sveltejs/kit';
import { requireUser } from '$server/auth';
import { ownedFileVersion } from '$server/versions';
import { filesStore } from '$server/blob-store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals);
	const { version } = await ownedFileVersion(params.id, params.versionId, user.id);
	const index = Number(params.index);
	if (!Number.isInteger(index) || index < 0 || index >= version.totalChunks) error(400, 'Invalid chunk index');
	const chunk = await filesStore().get(`${version.storageKey}/chunk-${index}`);
	if (!chunk) error(404, 'Chunk not found');
	return json({ chunk: Buffer.from(chunk).toString('base64') }, { headers: { 'Cache-Control': 'no-store' } });
};
