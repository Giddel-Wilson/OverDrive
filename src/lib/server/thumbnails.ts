import { error } from '@sveltejs/kit';
import { filesStore, sha256Hex, thumbnailKey } from './blob-store';
import { MAX_THUMBNAIL_BYTES } from '$lib/shared/limits';

export interface ThumbnailPayload { encryptedBlob: string; iv: string; ciphertextSha256: string }

export async function thumbnailBytes(payload: ThumbnailPayload): Promise<Uint8Array> {
	const bytes = new Uint8Array(Buffer.from(payload.encryptedBlob, 'base64'));
	if (bytes.length < 16 || bytes.length > MAX_THUMBNAIL_BYTES) error(400, 'Invalid encrypted thumbnail size');
	if (await sha256Hex(bytes) !== payload.ciphertextSha256) error(400, 'Thumbnail integrity hash does not match');
	return bytes;
}

export async function storeThumbnail(prefix: string, payload: ThumbnailPayload, bytes: Uint8Array) {
	const store = filesStore();
	const key = thumbnailKey(prefix, payload.ciphertextSha256);
	await store.set(key, Uint8Array.from(bytes).buffer);
	const readBack = await store.get(key);
	if (!readBack || await sha256Hex(new Uint8Array(readBack)) !== payload.ciphertextSha256) {
		await store.delete(key).catch(() => {});
		error(502, 'The encrypted thumbnail did not store correctly. Retry the upload.');
	}
}
