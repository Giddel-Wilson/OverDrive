import { describe, it, expect } from 'vitest';
import { encryptPhotoThumbnail, decryptPhotoThumbnail, createPhotoThumbnail } from '../thumbnails';
import { generateFileKey, decryptBlob } from '../file-encryption';
import { fromBase64 } from '../encoding';
import legacy from '../../shared/__tests__/fixtures/pre-rebrand.json';

describe('encrypted photo thumbnails', () => {
	it('decrypts an existing v1 thumbnail after the rebrand', async () => {
		const ciphertext = fromBase64(legacy.thumbnail.ciphertext);
		const manifest = { iv: legacy.thumbnail.iv, ciphertextSha256: legacy.thumbnail.sha256, sizeBytes: ciphertext.length };
		const restored = await decryptPhotoThumbnail(ciphertext, manifest, Uint8Array.from({ length: 32 }, (_, i) => i));
		expect(restored.type).toBe('image/png');
		expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]));
	});

	it('round-trips the derivative and its MIME type with a separate key from the original', async () => {
		const key = generateFileKey();
		const image = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], { type: 'image/png' });
		const encrypted = await encryptPhotoThumbnail(image, key);
		const ciphertext = fromBase64(encrypted.encryptedBlob);
		const manifest = { iv: encrypted.iv, ciphertextSha256: encrypted.ciphertextSha256, sizeBytes: ciphertext.length };
		const restored = await decryptPhotoThumbnail(ciphertext, manifest, key);
		expect(restored.type).toBe('image/png');
		expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array(await image.arrayBuffer()));
		await expect(decryptBlob(ciphertext, key, 'AES-GCM', fromBase64(encrypted.iv))).rejects.toThrow();
		await expect(decryptPhotoThumbnail(ciphertext, manifest, generateFileKey())).rejects.toThrow();
	});
	it('rejects modified ciphertext, malformed sizes and active image formats', async () => {
		const key = generateFileKey();
		const encrypted = await encryptPhotoThumbnail(new Blob(['small image'], { type: 'image/webp' }), key);
		const ciphertext = fromBase64(encrypted.encryptedBlob);
		const manifest = { iv: encrypted.iv, ciphertextSha256: encrypted.ciphertextSha256, sizeBytes: ciphertext.length };
		await expect(decryptPhotoThumbnail(ciphertext, { ...manifest, sizeBytes: 1 }, key)).rejects.toThrow();
		ciphertext[0] ^= 1;
		await expect(decryptPhotoThumbnail(ciphertext, manifest, key)).rejects.toThrow('integrity');
		await expect(encryptPhotoThumbnail(new Blob(['<svg/>'], { type: 'image/svg+xml' }), key)).rejects.toThrow();
		expect(await createPhotoThumbnail(new Blob(['<svg/>'], { type: 'image/svg+xml' }))).toBeNull();
	});
});
