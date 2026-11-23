import { fromBase64, toBase64 } from './encoding';
import { unwrapRecordFileKey, type EncryptedFileRecord } from './download-pipeline';
import { wrapKeyWithPassword, unwrapKeyWithPassword, IncorrectPasswordError } from './password-wrap';
import { DEFAULT_ARGON2ID_PARAMS } from './kdf';
import type { KdfParams } from './types';

export interface CreateShareLinkOptions {
	maxDownloads?: number | null;
	expiresAt?: string | null; // ISO datetime
	kdfParams?: KdfParams;
}

/**
 * Unwraps the file's real key with the owner's private key, then re-wraps
 * it under a fresh key derived from the share password (Argon2id by
 * default). The server only ever receives this password-wrapped copy —
 * it never sees the share password or the underlying file key.
 */
export async function createShareLink(
	record: EncryptedFileRecord,
	ownerPrivateKey: CryptoKey,
	sharePassword: string,
	opts: CreateShareLinkOptions = {}
): Promise<{ token: string; url: string }> {
	const fileKey = await unwrapRecordFileKey(record, ownerPrivateKey);
	const kdfParams = opts.kdfParams ?? DEFAULT_ARGON2ID_PARAMS;
	const wrapped = await wrapKeyWithPassword(fileKey, sharePassword, kdfParams);

	const res = await fetch(`/api/files/${record.id}/share`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			versionNumber: record.versionNumber ?? 1,
			wrappedFileKey: toBase64(wrapped.wrapped),
			kdf: kdfParams.kdf,
			kdfSalt: toBase64(wrapped.salt),
			kdfParams,
			wrapIv: toBase64(wrapped.iv),
			maxDownloads: opts.maxDownloads ?? null,
			expiresAt: opts.expiresAt ?? null
		})
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.message ?? 'Failed to create share link');
	}
	return res.json();
}

/** Shape returned by GET /api/share/[token] — the public, unauthenticated endpoint. */
export interface ShareRecord {
	fileId: string;
	versionNumber: number;
	fileAlgo: EncryptedFileRecord['fileAlgo'];
	fileIv: string;
	totalChunks: number;
	ciphertextSha256: string;
	wrappedFileKey: string;
	kdf: KdfParams['kdf'];
	kdfSalt: string;
	kdfParams: Record<string, unknown>;
	wrapIv: string;
	metadata: EncryptedFileRecord['metadata'];
}

/** Re-derives the share password's key and unwraps the file key — entirely client-side. */
export async function unwrapShareFileKey(record: ShareRecord, password: string): Promise<Uint8Array> {
	let wrapped: Uint8Array;
	let iv: Uint8Array;
	let salt: Uint8Array;
	try {
		wrapped = fromBase64(record.wrappedFileKey);
		iv = fromBase64(record.wrapIv);
		salt = fromBase64(record.kdfSalt);
		if (wrapped.length !== 48 || iv.length !== 12 || salt.length < 16) throw new Error('Invalid key descriptor');
	} catch {
		throw new Error('This share link has invalid encryption data. Ask the sender for a new link.');
	}
	try {
		return await unwrapKeyWithPassword(
			{
				wrapped,
				iv,
				salt,
				// The stored algorithm also supports older parameter objects
				// that omitted their redundant KDF discriminator.
				kdfParams: { ...record.kdfParams, kdf: record.kdf } as unknown as KdfParams
			},
			password
		);
	} catch (error) {
		if (error instanceof IncorrectPasswordError) throw error;
		throw new Error('Your browser could not initialize file decryption. Reload this page and try again.', { cause: error });
	}
}

/** Adapts a ShareRecord into the shape downloadAndDecryptFile expects. */
export function shareRecordAsEncryptedFileRecord(record: ShareRecord): EncryptedFileRecord {
	return {
		id: record.fileId,
		fileAlgo: record.fileAlgo,
		fileIv: record.fileIv,
		keyAlgo: 'RSA-OAEP', // unused here — the file key arrives already unwrapped via password
		wrappedFileKey: '',
		keyWrapIv: null,
		keyWrapEphemeralPublicKeyJwk: null,
		totalChunks: record.totalChunks,
		ciphertextSha256: record.ciphertextSha256,
		metadata: record.metadata
	};
}
