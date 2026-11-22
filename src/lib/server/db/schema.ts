import {
	pgTable,
	uuid,
	text,
	timestamp,
	bigint,
	jsonb,
	boolean,
	integer,
	pgEnum,
	index,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const fileAlgoEnum = pgEnum('file_algo', ['AES-GCM', 'ChaCha20-Poly1305']);
export const keyAlgoEnum = pgEnum('key_algo', ['RSA-OAEP', 'ECDH-P256']);
export const kdfAlgoEnum = pgEnum('kdf_algo', ['PBKDF2', 'Argon2id']);
export const accessActionEnum = pgEnum('access_action', [
	'UPLOAD',
	'DOWNLOAD',
	'DECRYPT_ATTEMPT',
	'SHARE_CREATE',
	'SHARE_REVOKE',
	'DELETE',
	'VIEW_METADATA'
]);

// ---------------------------------------------------------------------------
// Users
// Note: the server stores only a public key (for RSA-OAEP/ECDH key wrapping)
// and an Argon2id/PBKDF2 verifier for auth. It never stores a private key,
// a master encryption key, or plaintext file keys.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
	id: uuid('id').defaultRandom().primaryKey(),
	email: text('email').notNull().unique(),
	displayName: text('display_name').notNull(),

	// Auth verifier only (Argon2id hash of the login password). This is
	// NEVER the same secret used to derive file encryption keys.
	authHash: text('auth_hash').notNull(),
	authSalt: text('auth_salt').notNull(),
	authKdf: kdfAlgoEnum('auth_kdf').notNull().default('Argon2id'),

	// Public half of the user's asymmetric keypair, used by senders to wrap
	// a per-file symmetric key for this recipient. Generated client-side;
	// the matching private key never leaves the browser unencrypted.
	publicKeyJwk: jsonb('public_key_jwk').notNull(),
	keyAlgo: keyAlgoEnum('key_algo').notNull().default('RSA-OAEP'),

	// The private key, itself encrypted client-side with a key derived from
	// the user's password (Argon2id/PBKDF2), stored only so it can sync
	// across the user's own devices. Server cannot decrypt it.
	wrappedPrivateKey: text('wrapped_private_key').notNull(),
	wrappedPrivateKeyIv: text('wrapped_private_key_iv').notNull(),
	privateKeyKdf: kdfAlgoEnum('private_key_kdf').notNull().default('Argon2id'),
	privateKeyKdfParams: jsonb('private_key_kdf_params').notNull(),

	// Account recovery: a SECOND copy of the private key, encrypted under a
	// key derived (HKDF) from a random 256-bit recovery key that only the
	// user holds. The server stores the ciphertext plus a SHA-256 of a
	// separately-derived proof token (never the recovery key itself) so it
	// can authorise a password reset without being able to decrypt anything.
	recoveryWrappedPrivateKey: text('recovery_wrapped_private_key'),
	recoveryIv: text('recovery_iv'),
	recoveryAuthHash: text('recovery_auth_hash'),

	// TOTP two-factor auth. The secret is encrypted at rest with a key
	// derived from SESSION_SECRET (see server/two-factor.ts).
	totpSecretEnc: text('totp_secret_enc'),
	totpEnabled: boolean('totp_enabled').notNull().default(false),
	totpLastStep: bigint('totp_last_step', { mode: 'number' }),

	// Per-user storage limit in bytes. null = use the server default
	// (DEFAULT_QUOTA_GB); 0 = unlimited. Set by an admin or by the invite
	// the account was created with.
	storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }),
	// The invite this account was created with (informational, no FK: the
	// invites table references users, and this keeps the two independent).
	inviteId: uuid('invite_id'),

	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	lastLoginAt: timestamp('last_login_at', { withTimezone: true })
});

// ---------------------------------------------------------------------------
// encrypted_files
// The raw ciphertext blob lives in object storage (Backblaze B2, S3-compatible); this
// row tracks the storage pointer plus everything needed to reproduce the
// decryption pipeline. No field here can reconstruct plaintext on its own.
// ---------------------------------------------------------------------------

export const encryptedFiles = pgTable(
	'encrypted_files',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		ownerId: uuid('owner_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		// Pointer to ciphertext in blob storage — server streams bytes,
		// never holds full file in memory, never inspects content.
		storageKey: text('storage_key').notNull(),
		storageProvider: text('storage_provider').notNull().default('backblaze-b2'),
		ciphertextSizeBytes: bigint('ciphertext_size_bytes', { mode: 'number' }).notNull(),

		// File content encryption
		fileAlgo: fileAlgoEnum('file_algo').notNull(),
		fileIv: text('file_iv').notNull(), // base64, 96-bit nonce
		fileAuthTag: text('file_auth_tag'), // base64, separate when not appended to ciphertext
		chunked: boolean('chunked').notNull().default(true),
		chunkSizeBytes: integer('chunk_size_bytes').notNull().default(2097152), // 2 MiB

		// Per-file symmetric key, wrapped (encrypted) for the owner under
		// their public key. Server only ever sees ciphertext of this key.
		wrappedFileKey: text('wrapped_file_key').notNull(),
		keyAlgo: keyAlgoEnum('key_algo').notNull(),
		// Only present for ECDH-P256 wrapping: the ephemeral public key and
		// AES-GCM IV needed to redo the ECDH derivation on download. Null
		// for RSA-OAEP, which needs neither.
		keyWrapIv: text('key_wrap_iv'),
		keyWrapEphemeralPublicKeyJwk: jsonb('key_wrap_ephemeral_public_key_jwk'),

		// Total number of ciphertext chunks, set at upload init so the
		// download flow knows how many chunk requests to make.
		totalChunks: integer('total_chunks').notNull().default(1),

		// SHA-256 of ciphertext, computed client-side, used for integrity
		// verification on download before the browser attempts decryption.
		ciphertextSha256: text('ciphertext_sha256').notNull(),

		// 'uploading' until the finalize step has verified every chunk is in
		// object storage; 'complete' afterwards. Pre-existing rows default to
		// 'complete'. Incomplete uploads are resumable (see upload-pipeline).
		uploadStatus: text('upload_status').notNull().default('complete'),

		// Content revisions keep this file id stable. Replacement uploads are
		// separate pending rows until their chunks have all been verified.
		versionNumber: integer('version_number').notNull().default(1),
		contentUpdatedAt: timestamp('content_updated_at', { withTimezone: true }).notNull().defaultNow(),
		replacesFileId: uuid('replaces_file_id').references((): AnyPgColumn => encryptedFiles.id, { onDelete: 'cascade' }),
		baseVersion: integer('base_version'),

		// Browser-generated derivative, encrypted under a distinct HKDF key.
		// Its immutable object key includes its ciphertext hash.
		thumbnailIv: text('thumbnail_iv'),
		thumbnailSha256: text('thumbnail_sha256'),
		thumbnailSizeBytes: integer('thumbnail_size_bytes').notNull().default(0),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		// Set = "in the trash". Blobs are only removed on permanent delete.
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(t) => ({
		ownerIdx: index('encrypted_files_owner_idx').on(t.ownerId),
		createdIdx: index('encrypted_files_created_idx').on(t.createdAt),
		storageIdx: index('encrypted_files_storage_idx').on(t.storageKey),
		replacementIdx: index('encrypted_files_replacement_idx').on(t.replacesFileId)
	})
);

// ---------------------------------------------------------------------------
// folders
// Folder names and nesting live in an encrypted blob ({ name, parentId }),
// exactly like file metadata — the server only learns that N folders exist.
// Each folder has its own random key, wrapped under the owner's public key
// with the same RSA-OAEP / ECDH scheme used for files.
// ---------------------------------------------------------------------------

export const folders = pgTable(
	'folders',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		ownerId: uuid('owner_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		encryptedBlob: text('encrypted_blob').notNull(),
		iv: text('iv').notNull(),
		algo: fileAlgoEnum('algo').notNull(),

		wrappedKey: text('wrapped_key').notNull(),
		keyAlgo: keyAlgoEnum('key_algo').notNull(),
		keyWrapIv: text('key_wrap_iv'),
		keyWrapEphemeralPublicKeyJwk: jsonb('key_wrap_ephemeral_public_key_jwk'),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(t) => ({
		ownerIdx: index('folders_owner_idx').on(t.ownerId)
	})
);

// ---------------------------------------------------------------------------
// file_metadata
// Filename, mime type, etc. are themselves encrypted client-side — the
// server is metadata-blind by design, not just content-blind.
// ---------------------------------------------------------------------------

export const fileMetadata = pgTable('file_metadata', {
	fileId: uuid('file_id')
		.primaryKey()
		.references(() => encryptedFiles.id, { onDelete: 'cascade' }),

	// AES-GCM/ChaCha20 ciphertext of a JSON blob: { name, mimeType, size, ext }
	encryptedBlob: text('encrypted_blob').notNull(),
	iv: text('iv').notNull(),
	algo: fileAlgoEnum('algo').notNull(),

	// Encryption-strength indicator surfaced in the UI, derived from the
	// algorithm + key length combination chosen at upload time. Computed
	// client-side at encrypt time, never trusted as a security control.
	strengthScore: integer('strength_score').notNull(), // 0-100
	strengthLabel: text('strength_label').notNull() // weak | fair | good | strong
});

// Immutable encrypted revisions. Old chunks stay at their original storage
// pointer; neither replacing nor restoring a file decrypts anything server-side.
export const fileVersions = pgTable('file_versions', {
	id: uuid('id').defaultRandom().primaryKey(),
	fileId: uuid('file_id').notNull().references(() => encryptedFiles.id, { onDelete: 'cascade' }),
	versionNumber: integer('version_number').notNull(),
	storageKey: text('storage_key').notNull(),
	storageProvider: text('storage_provider').notNull(),
	ciphertextSizeBytes: bigint('ciphertext_size_bytes', { mode: 'number' }).notNull(),
	fileAlgo: fileAlgoEnum('file_algo').notNull(),
	fileIv: text('file_iv').notNull(),
	fileAuthTag: text('file_auth_tag'),
	chunked: boolean('chunked').notNull(),
	chunkSizeBytes: integer('chunk_size_bytes').notNull(),
	wrappedFileKey: text('wrapped_file_key').notNull(),
	keyAlgo: keyAlgoEnum('key_algo').notNull(),
	keyWrapIv: text('key_wrap_iv'),
	keyWrapEphemeralPublicKeyJwk: jsonb('key_wrap_ephemeral_public_key_jwk'),
	totalChunks: integer('total_chunks').notNull(),
	ciphertextSha256: text('ciphertext_sha256').notNull(),
	thumbnailIv: text('thumbnail_iv'),
	thumbnailSha256: text('thumbnail_sha256'),
	thumbnailSizeBytes: integer('thumbnail_size_bytes').notNull().default(0),
	metadataBlob: text('metadata_blob').notNull(),
	metadataIv: text('metadata_iv').notNull(),
	metadataAlgo: fileAlgoEnum('metadata_algo').notNull(),
	strengthScore: integer('strength_score').notNull(),
	strengthLabel: text('strength_label').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
	archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
	// Claim before deleting storage; a version being purged cannot be restored.
	purgingAt: timestamp('purging_at', { withTimezone: true })
}, (t) => ({ fileIdx: index('file_versions_file_idx').on(t.fileId, t.versionNumber), storageIdx: index('file_versions_storage_idx').on(t.storageKey) }));

// ---------------------------------------------------------------------------
// share_links
// Recipient-less link sharing: file key is re-wrapped under a key derived
// from a password the recipient must supply (PBKDF2/Argon2id), so the
// server still never holds a usable key.
// ---------------------------------------------------------------------------

export const shareLinks = pgTable('share_links', {
	id: uuid('id').defaultRandom().primaryKey(),
	fileId: uuid('file_id')
		.notNull()
		.references(() => encryptedFiles.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(), // URL-safe nanoid, lookup handle only
	// Null = current content. When content changes, existing links are pinned
	// to the immutable old version whose key was wrapped for this link.
	versionId: uuid('version_id').references(() => fileVersions.id, { onDelete: 'set null' }),

	wrappedFileKey: text('wrapped_file_key').notNull(),
	kdf: kdfAlgoEnum('kdf').notNull().default('Argon2id'),
	kdfSalt: text('kdf_salt').notNull(),
	kdfParams: jsonb('kdf_params').notNull(),
	wrapIv: text('wrap_iv').notNull(),

	maxDownloads: integer('max_downloads'),
	downloadCount: integer('download_count').notNull().default(0),
	// A reserved download can finish all of its chunks after using the last
	// allowed download. It also pins the revision until the grant expires.
	downloadGrantUntil: timestamp('download_grant_until', { withTimezone: true }),
	revocationReason: text('revocation_reason'),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),

	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ---------------------------------------------------------------------------
// access_logs
// Append-only audit trail. Logs actions and outcomes, never key material.
// ---------------------------------------------------------------------------

export const accessLogs = pgTable(
	'access_logs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		fileId: uuid('file_id').references(() => encryptedFiles.id, { onDelete: 'set null' }),
		actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
		shareToken: text('share_token'),

		action: accessActionEnum('action').notNull(),
		success: boolean('success').notNull().default(true),
		failureReason: text('failure_reason'),

		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => ({
		fileIdx: index('access_logs_file_idx').on(t.fileId),
		createdIdx: index('access_logs_created_idx').on(t.createdAt)
	})
);

// ---------------------------------------------------------------------------
// sessions
// One row per signed-in browser. The session cookie is a JWT carrying this
// row's id (`sid`); every request checks the row, so a session can be
// revoked server-side ("sign out that device") instead of living until the
// token expires.
// ---------------------------------------------------------------------------

export const sessions = pgTable(
	'sessions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		// Stable per browser/profile, retained in an HttpOnly cookie across logout.
		deviceId: uuid('device_id'),
		// Re-authentication rotates tokens without creating another device row.
		tokenVersion: integer('token_version').notNull().default(1),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		revokedAt: timestamp('revoked_at', { withTimezone: true })
	},
	(t) => ({
		userIdx: index('sessions_user_idx').on(t.userId),
		deviceUnique: uniqueIndex('sessions_user_device_unique').on(t.userId, t.deviceId)
	})
);

// ---------------------------------------------------------------------------
// invites
// Sign-up codes. Only a SHA-256 of the code is stored; the plaintext is
// shown to the admin once, at creation.
// ---------------------------------------------------------------------------

export const invites = pgTable('invites', {
	id: uuid('id').defaultRandom().primaryKey(),
	codeHash: text('code_hash').notNull().unique(),
	note: text('note'),
	createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
	maxUses: integer('max_uses').notNull().default(1),
	uses: integer('uses').notNull().default(0),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	// Storage limit given to accounts created with this invite (null = default).
	quotaBytes: bigint('quota_bytes', { mode: 'number' }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// ---------------------------------------------------------------------------
// maintenance_state — tiny key/value store for the cleanup job (e.g. where
// the orphan-chunk sweep left off, so a big bucket is covered across runs).
// ---------------------------------------------------------------------------

export const maintenanceState = pgTable('maintenance_state', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
