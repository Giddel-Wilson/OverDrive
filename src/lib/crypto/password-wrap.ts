import { deriveKey } from './kdf';
import type { KdfParams, PasswordWrappedKey } from './types';

/** Authentication failed after the password-derived key was ready. */
export class IncorrectPasswordError extends Error {
	constructor() {
		super('Incorrect password');
		this.name = 'IncorrectPasswordError';
	}
}

/** Wraps a raw file key under a key derived from a share-link password. */
export async function wrapKeyWithPassword(
	fileKey: Uint8Array,
	password: string,
	kdfParams: KdfParams
): Promise<PasswordWrappedKey> {
	const { key, salt } = await deriveKey(password, kdfParams);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey('raw', Uint8Array.from(key).buffer, 'AES-GCM', false, ['encrypt']);
	const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv).buffer }, cryptoKey, Uint8Array.from(fileKey).buffer);
	return { wrapped: new Uint8Array(wrapped), iv, salt, kdfParams };
}

export async function unwrapKeyWithPassword(
	payload: PasswordWrappedKey,
	password: string
): Promise<Uint8Array> {
	const { key } = await deriveKey(password, payload.kdfParams, payload.salt);
	const cryptoKey = await crypto.subtle.importKey('raw', Uint8Array.from(key).buffer, 'AES-GCM', false, ['decrypt']);
	try {
		const fileKey = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: Uint8Array.from(payload.iv).buffer },
			cryptoKey,
			Uint8Array.from(payload.wrapped).buffer
		);
		return new Uint8Array(fileKey);
	} catch (error) {
		if (error && typeof error === 'object' && 'name' in error && error.name === 'OperationError') throw new IncorrectPasswordError();
		throw error;
	}
}
