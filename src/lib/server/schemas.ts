import { z } from 'zod';

const keyAlgoSchema = z.enum(['RSA-OAEP', 'ECDH-P256']);
const fileAlgoSchema = z.enum(['AES-GCM', 'ChaCha20-Poly1305']);
const kdfAlgoSchema = z.enum(['PBKDF2', 'Argon2id']);
const base64Schema = z.string().min(1).max(50_000);

const recoveryFields = {
	// Second copy of the private key, encrypted under the recovery key, plus
	// a proof token derived from that key (hex, 32 bytes).
	recoveryWrappedPrivateKey: base64Schema,
	recoveryIv: base64Schema,
	recoveryAuthToken: z.string().regex(/^[0-9a-f]{64}$/)
};

export const registerSchema = z.object({
	email: z.string().trim().toLowerCase().email().max(320),
	displayName: z.string().trim().min(1).max(80).optional(),
	password: z.string().min(12).max(256),
	publicKeyJwk: z.record(z.unknown()),
	keyAlgo: keyAlgoSchema,
	wrappedPrivateKey: base64Schema,
	wrappedPrivateKeyIv: base64Schema,
	privateKeyKdf: kdfAlgoSchema,
	privateKeyKdfParams: z.record(z.unknown()),
	recoveryWrappedPrivateKey: recoveryFields.recoveryWrappedPrivateKey.optional(),
	recoveryIv: recoveryFields.recoveryIv.optional(),
	recoveryAuthToken: recoveryFields.recoveryAuthToken.optional()
});

export const loginSchema = z.object({
	email: z.string().trim().toLowerCase().email().max(320),
	password: z.string().min(1).max(256),
	totp: z.string().regex(/^\d{6}$/).optional()
});

/** Set or replace the recovery key for the signed-in account. */
export const setRecoveryKeySchema = z.object({
	currentPassword: z.string().min(1).max(256),
	...recoveryFields
});

/** Use the recovery key to set a new password when the old one is lost. */
export const recoverSchema = z.object({
	email: z.string().trim().toLowerCase().email().max(320),
	recoveryAuthToken: recoveryFields.recoveryAuthToken,
	newPassword: z.string().min(12).max(256),
	wrappedPrivateKey: base64Schema,
	wrappedPrivateKeyIv: base64Schema,
	privateKeyKdf: kdfAlgoSchema,
	privateKeyKdfParams: z.record(z.unknown())
});

export const twoFactorSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('setup') }),
	z.object({ action: z.literal('enable'), code: z.string().regex(/^\d{6}$/) }),
	z.object({ action: z.literal('disable'), password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/) })
]);

export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1).max(256),
	newPassword: z.string().min(12).max(256),
	wrappedPrivateKey: base64Schema,
	wrappedPrivateKeyIv: base64Schema,
	privateKeyKdf: kdfAlgoSchema,
	privateKeyKdfParams: z.record(z.unknown())
});

export const uploadInitSchema = z.object({
	action: z.literal('init'),
	fileAlgo: fileAlgoSchema,
	keyAlgo: keyAlgoSchema,
	fileIv: base64Schema,
	wrappedFileKey: base64Schema,
	wrapIv: base64Schema.nullable().optional(),
	ephemeralPublicKeyJwk: z.record(z.unknown()).nullable().optional(),
	metadata: z.object({
		encryptedBlob: base64Schema,
		iv: base64Schema,
		algo: fileAlgoSchema,
		strengthScore: z.number().int().min(0).max(100),
		strengthLabel: z.enum(['weak', 'fair', 'good', 'strong'])
	}),
	totalChunks: z.number().int().min(1).max(100_000),
	chunkSizeBytes: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
	ciphertextSizeBytesEstimate: z.number().int().min(0)
});

export const uploadFinalizeSchema = z.object({
	action: z.literal('finalize'),
	fileId: z.string().uuid(),
	ciphertextSha256: z.string().length(64)
});

export const uploadPresignSchema = z.object({
	action: z.literal('presign'),
	fileId: z.string().uuid(),
	indexes: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(64)
});

/** Replace a file's encrypted metadata blob (rename / move). */
export const metadataUpdateSchema = z.object({
	encryptedBlob: base64Schema,
	iv: base64Schema
});

export const folderCreateSchema = z.object({
	encryptedBlob: base64Schema,
	iv: base64Schema,
	algo: fileAlgoSchema,
	wrappedKey: base64Schema,
	keyAlgo: keyAlgoSchema,
	keyWrapIv: base64Schema.nullable().optional(),
	keyWrapEphemeralPublicKeyJwk: z.record(z.unknown()).nullable().optional()
});

export const trashSchema = z.object({
	action: z.enum(['trash', 'restore', 'purge']),
	fileIds: z.array(z.string().uuid()).max(500),
	folderIds: z.array(z.string().uuid()).max(500)
});

export const shareCreateSchema = z.object({
	wrappedFileKey: base64Schema,
	kdf: kdfAlgoSchema,
	kdfSalt: base64Schema,
	kdfParams: z.record(z.unknown()),
	wrapIv: base64Schema,
	maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
	expiresAt: z.string().datetime().nullable().optional()
});
