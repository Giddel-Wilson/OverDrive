import { error, json } from '@sveltejs/kit';
import { filesStore } from '$server/blob-store';
import { logAccess } from '$server/access-log';
import { sharedFile, verifyDownloadGrant } from '$server/shared-files';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, getClientAddress, url }) => {
	const revision = await verifyDownloadGrant(url.searchParams.get('grant'), params.token);
	const { link, root, content: file } = await sharedFile(params.token, false, true);
	if (file.versionNumber !== revision) error(409, 'The shared version changed. Start the download again.');

	const chunkIndex = Number(params.index);
	if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= file.totalChunks) {
		error(400, 'Invalid chunk index');
	}

	const store = filesStore();
	const key = `${file.storageKey || `${root.ownerId}/${root.id}`}/chunk-${chunkIndex}`;
	const chunk = await store.get(key, { type: 'arrayBuffer' });
	if (!chunk) error(404, 'Chunk not found');

	// Log the first chunk of an admitted download. Its grant was reserved
	// once in POST; subsequent chunk requests never consume another slot.
	if (chunkIndex === 0) {
		await logAccess({
			fileId: root.id,
			shareToken: link.token,
			action: 'DOWNLOAD',
			success: true,
			ipAddress: getClientAddress()
		});
	}

	return json({ chunk: Buffer.from(new Uint8Array(chunk)).toString('base64') }, { headers: { 'Cache-Control': 'no-store' } });
};
