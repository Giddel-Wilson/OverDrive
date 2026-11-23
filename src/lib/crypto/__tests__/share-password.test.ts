import { afterEach, describe, expect, it, vi } from 'vitest';
import * as kdf from '../kdf';
import { wrapKeyWithPassword } from '../password-wrap';
import { unwrapShareFileKey, type ShareRecord } from '../share-pipeline';
import { toBase64 } from '../encoding';
import type { KdfParams } from '../types';

const password = 'a shared password';
const fileKey = Uint8Array.from({ length: 32 }, (_, i) => i);

async function record(params: KdfParams): Promise<ShareRecord> {
	const wrapped = await wrapKeyWithPassword(fileKey, password, params);
	return {
		fileId: 'test-file', versionNumber: 1, fileAlgo: 'AES-GCM', fileIv: '', totalChunks: 1,
		ciphertextSha256: 'a'.repeat(64), wrappedFileKey: toBase64(wrapped.wrapped),
		kdf: params.kdf, kdfSalt: toBase64(wrapped.salt), kdfParams: { ...params },
		wrapIv: toBase64(wrapped.iv), metadata: null
	};
}

afterEach(() => vi.restoreAllMocks());

describe('share password decryption', () => {
	it('opens an existing default Argon2id link and rejects a genuinely wrong password', async () => {
		const shared = await record(kdf.DEFAULT_ARGON2ID_PARAMS);
		expect(await unwrapShareFileKey(shared, password)).toEqual(fileKey);
		await expect(unwrapShareFileKey(shared, 'a different password')).rejects.toThrow('Incorrect password');
	}, 15_000);

	it('uses the stored KDF for older parameter objects without a discriminator', async () => {
		const shared = await record({ kdf: 'PBKDF2', iterations: 10_000, hash: 'SHA-256' });
		delete shared.kdfParams.kdf;
		expect(await unwrapShareFileKey(shared, password)).toEqual(fileKey);
	});

	it('reports encryption startup failures separately from password authentication failures', async () => {
		const shared = await record({ kdf: 'PBKDF2', iterations: 10_000, hash: 'SHA-256' });
		vi.spyOn(kdf, 'deriveKey').mockRejectedValueOnce(new DOMException('Encryption startup was blocked', 'OperationError'));
		await expect(unwrapShareFileKey(shared, password)).rejects.toThrow('could not initialize file decryption');
	});

	it('identifies a malformed descriptor before asking the user to retry their password', async () => {
		const shared = await record({ kdf: 'PBKDF2', iterations: 10_000, hash: 'SHA-256' });
		shared.wrapIv = toBase64(new Uint8Array(1));
		await expect(unwrapShareFileKey(shared, password)).rejects.toThrow('invalid encryption data');
	});
});
