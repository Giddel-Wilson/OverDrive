import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { encryptChunk, decryptChunk } from '../file-encryption';

it('encrypts and decrypts ChaCha data, keys, nonces and AAD supplied from another realm', async () => {
	const foreign = runInNewContext('({ message: new Uint8Array([1, 2, 3]), key: new Uint8Array(32), nonce: new Uint8Array(12), aad: new Uint8Array([9]) })');
	expect(foreign.message instanceof Uint8Array).toBe(false);
	const ciphertext = await encryptChunk(foreign.message, foreign.key, 'ChaCha20-Poly1305', foreign.nonce, foreign.aad);
	const foreignCiphertext = runInNewContext('new Uint8Array(input)', { input: ciphertext });
	expect(await decryptChunk(foreignCiphertext, foreign.key, 'ChaCha20-Poly1305', foreign.nonce, foreign.aad)).toEqual(new Uint8Array([1, 2, 3]));
	expect(Array.from(foreign.message)).toEqual([1, 2, 3]);
});
