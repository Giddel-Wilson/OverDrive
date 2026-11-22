import { pgTable, index, foreignKey, check, uuid, text, boolean, timestamp, bigint, integer, jsonb, unique, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const accessAction = pgEnum("access_action", ['UPLOAD', 'DOWNLOAD', 'DECRYPT_ATTEMPT', 'SHARE_CREATE', 'SHARE_REVOKE', 'DELETE', 'VIEW_METADATA'])
export const fileAlgo = pgEnum("file_algo", ['AES-GCM', 'ChaCha20-Poly1305'])
export const kdfAlgo = pgEnum("kdf_algo", ['PBKDF2', 'Argon2id'])
export const keyAlgo = pgEnum("key_algo", ['RSA-OAEP', 'ECDH-P256'])


export const accessLogs = pgTable("access_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fileId: uuid("file_id"),
	actorId: uuid("actor_id"),
	shareToken: text("share_token"),
	action: accessAction().notNull(),
	success: boolean().default(true).notNull(),
	failureReason: text("failure_reason"),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		createdIdx: index("access_logs_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
		fileIdx: index("access_logs_file_idx").using("btree", table.fileId.asc().nullsLast().op("uuid_ops")),
		accessLogsFileIdEncryptedFilesIdFk: foreignKey({
			columns: [table.fileId],
			foreignColumns: [encryptedFiles.id],
			name: "access_logs_file_id_encrypted_files_id_fk"
		}).onDelete("set null"),
		accessLogsActorIdUsersIdFk: foreignKey({
			columns: [table.actorId],
			foreignColumns: [users.id],
			name: "access_logs_actor_id_users_id_fk"
		}).onDelete("set null"),
		accessLogsIdNotNull: check("access_logs_id_not_null", sql`NOT NULL id`),
		accessLogsActionNotNull: check("access_logs_action_not_null", sql`NOT NULL action`),
		accessLogsSuccessNotNull: check("access_logs_success_not_null", sql`NOT NULL success`),
		accessLogsCreatedAtNotNull: check("access_logs_created_at_not_null", sql`NOT NULL created_at`),
	}
});

export const encryptedFiles = pgTable("encrypted_files", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	storageKey: text("storage_key").notNull(),
	storageProvider: text("storage_provider").default('backblaze-b2').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ciphertextSizeBytes: bigint("ciphertext_size_bytes", { mode: "number" }).notNull(),
	fileAlgo: fileAlgo("file_algo").notNull(),
	fileIv: text("file_iv").notNull(),
	fileAuthTag: text("file_auth_tag"),
	chunked: boolean().default(true).notNull(),
	chunkSizeBytes: integer("chunk_size_bytes").default(2097152).notNull(),
	wrappedFileKey: text("wrapped_file_key").notNull(),
	keyAlgo: keyAlgo("key_algo").notNull(),
	ciphertextSha256: text("ciphertext_sha256").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	keyWrapIv: text("key_wrap_iv"),
	keyWrapEphemeralPublicKeyJwk: jsonb("key_wrap_ephemeral_public_key_jwk"),
	totalChunks: integer("total_chunks").default(1).notNull(),
	uploadStatus: text("upload_status").default('complete').notNull(),
}, (table) => {
	return {
		createdIdx: index("encrypted_files_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
		ownerIdx: index("encrypted_files_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		encryptedFilesOwnerIdUsersIdFk: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [users.id],
			name: "encrypted_files_owner_id_users_id_fk"
		}).onDelete("cascade"),
		encryptedFilesIdNotNull: check("encrypted_files_id_not_null", sql`NOT NULL id`),
		encryptedFilesOwnerIdNotNull: check("encrypted_files_owner_id_not_null", sql`NOT NULL owner_id`),
		encryptedFilesStorageKeyNotNull: check("encrypted_files_storage_key_not_null", sql`NOT NULL storage_key`),
		encryptedFilesStorageProviderNotNull: check("encrypted_files_storage_provider_not_null", sql`NOT NULL storage_provider`),
		encryptedFilesCiphertextSizeBytesNotNull: check("encrypted_files_ciphertext_size_bytes_not_null", sql`NOT NULL ciphertext_size_bytes`),
		encryptedFilesFileAlgoNotNull: check("encrypted_files_file_algo_not_null", sql`NOT NULL file_algo`),
		encryptedFilesFileIvNotNull: check("encrypted_files_file_iv_not_null", sql`NOT NULL file_iv`),
		encryptedFilesChunkedNotNull: check("encrypted_files_chunked_not_null", sql`NOT NULL chunked`),
		encryptedFilesChunkSizeBytesNotNull: check("encrypted_files_chunk_size_bytes_not_null", sql`NOT NULL chunk_size_bytes`),
		encryptedFilesWrappedFileKeyNotNull: check("encrypted_files_wrapped_file_key_not_null", sql`NOT NULL wrapped_file_key`),
		encryptedFilesKeyAlgoNotNull: check("encrypted_files_key_algo_not_null", sql`NOT NULL key_algo`),
		encryptedFilesCiphertextSha256NotNull: check("encrypted_files_ciphertext_sha256_not_null", sql`NOT NULL ciphertext_sha256`),
		encryptedFilesCreatedAtNotNull: check("encrypted_files_created_at_not_null", sql`NOT NULL created_at`),
		encryptedFilesTotalChunksNotNull: check("encrypted_files_total_chunks_not_null", sql`NOT NULL total_chunks`),
		encryptedFilesUploadStatusNotNull: check("encrypted_files_upload_status_not_null", sql`NOT NULL upload_status`),
	}
});

export const fileMetadata = pgTable("file_metadata", {
	fileId: uuid("file_id").primaryKey().notNull(),
	encryptedBlob: text("encrypted_blob").notNull(),
	iv: text().notNull(),
	algo: fileAlgo().notNull(),
	strengthScore: integer("strength_score").notNull(),
	strengthLabel: text("strength_label").notNull(),
}, (table) => {
	return {
		fileMetadataFileIdEncryptedFilesIdFk: foreignKey({
			columns: [table.fileId],
			foreignColumns: [encryptedFiles.id],
			name: "file_metadata_file_id_encrypted_files_id_fk"
		}).onDelete("cascade"),
		fileMetadataFileIdNotNull: check("file_metadata_file_id_not_null", sql`NOT NULL file_id`),
		fileMetadataEncryptedBlobNotNull: check("file_metadata_encrypted_blob_not_null", sql`NOT NULL encrypted_blob`),
		fileMetadataIvNotNull: check("file_metadata_iv_not_null", sql`NOT NULL iv`),
		fileMetadataAlgoNotNull: check("file_metadata_algo_not_null", sql`NOT NULL algo`),
		fileMetadataStrengthScoreNotNull: check("file_metadata_strength_score_not_null", sql`NOT NULL strength_score`),
		fileMetadataStrengthLabelNotNull: check("file_metadata_strength_label_not_null", sql`NOT NULL strength_label`),
	}
});

export const shareLinks = pgTable("share_links", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fileId: uuid("file_id").notNull(),
	token: text().notNull(),
	wrappedFileKey: text("wrapped_file_key").notNull(),
	kdf: kdfAlgo().default('Argon2id').notNull(),
	kdfSalt: text("kdf_salt").notNull(),
	kdfParams: jsonb("kdf_params").notNull(),
	wrapIv: text("wrap_iv").notNull(),
	maxDownloads: integer("max_downloads"),
	downloadCount: integer("download_count").default(0).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		shareLinksFileIdEncryptedFilesIdFk: foreignKey({
			columns: [table.fileId],
			foreignColumns: [encryptedFiles.id],
			name: "share_links_file_id_encrypted_files_id_fk"
		}).onDelete("cascade"),
		shareLinksTokenUnique: unique("share_links_token_unique").on(table.token),
		shareLinksIdNotNull: check("share_links_id_not_null", sql`NOT NULL id`),
		shareLinksFileIdNotNull: check("share_links_file_id_not_null", sql`NOT NULL file_id`),
		shareLinksTokenNotNull: check("share_links_token_not_null", sql`NOT NULL token`),
		shareLinksWrappedFileKeyNotNull: check("share_links_wrapped_file_key_not_null", sql`NOT NULL wrapped_file_key`),
		shareLinksKdfNotNull: check("share_links_kdf_not_null", sql`NOT NULL kdf`),
		shareLinksKdfSaltNotNull: check("share_links_kdf_salt_not_null", sql`NOT NULL kdf_salt`),
		shareLinksKdfParamsNotNull: check("share_links_kdf_params_not_null", sql`NOT NULL kdf_params`),
		shareLinksWrapIvNotNull: check("share_links_wrap_iv_not_null", sql`NOT NULL wrap_iv`),
		shareLinksDownloadCountNotNull: check("share_links_download_count_not_null", sql`NOT NULL download_count`),
		shareLinksCreatedAtNotNull: check("share_links_created_at_not_null", sql`NOT NULL created_at`),
	}
});

export const folders = pgTable("folders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	encryptedBlob: text("encrypted_blob").notNull(),
	iv: text().notNull(),
	algo: fileAlgo().notNull(),
	wrappedKey: text("wrapped_key").notNull(),
	keyAlgo: keyAlgo("key_algo").notNull(),
	keyWrapIv: text("key_wrap_iv"),
	keyWrapEphemeralPublicKeyJwk: jsonb("key_wrap_ephemeral_public_key_jwk"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		ownerIdx: index("folders_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		foldersOwnerIdUsersIdFk: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [users.id],
			name: "folders_owner_id_users_id_fk"
		}).onDelete("cascade"),
		foldersIdNotNull: check("folders_id_not_null", sql`NOT NULL id`),
		foldersOwnerIdNotNull: check("folders_owner_id_not_null", sql`NOT NULL owner_id`),
		foldersEncryptedBlobNotNull: check("folders_encrypted_blob_not_null", sql`NOT NULL encrypted_blob`),
		foldersIvNotNull: check("folders_iv_not_null", sql`NOT NULL iv`),
		foldersAlgoNotNull: check("folders_algo_not_null", sql`NOT NULL algo`),
		foldersWrappedKeyNotNull: check("folders_wrapped_key_not_null", sql`NOT NULL wrapped_key`),
		foldersKeyAlgoNotNull: check("folders_key_algo_not_null", sql`NOT NULL key_algo`),
		foldersCreatedAtNotNull: check("folders_created_at_not_null", sql`NOT NULL created_at`),
	}
});

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	displayName: text("display_name").notNull(),
	authHash: text("auth_hash").notNull(),
	authSalt: text("auth_salt").notNull(),
	authKdf: kdfAlgo("auth_kdf").default('Argon2id').notNull(),
	publicKeyJwk: jsonb("public_key_jwk").notNull(),
	keyAlgo: keyAlgo("key_algo").default('RSA-OAEP').notNull(),
	wrappedPrivateKey: text("wrapped_private_key").notNull(),
	wrappedPrivateKeyIv: text("wrapped_private_key_iv").notNull(),
	privateKeyKdf: kdfAlgo("private_key_kdf").default('Argon2id').notNull(),
	privateKeyKdfParams: jsonb("private_key_kdf_params").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	recoveryWrappedPrivateKey: text("recovery_wrapped_private_key"),
	recoveryIv: text("recovery_iv"),
	recoveryAuthHash: text("recovery_auth_hash"),
	totpSecretEnc: text("totp_secret_enc"),
	totpEnabled: boolean("totp_enabled").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totpLastStep: bigint("totp_last_step", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }).default(0),
}, (table) => {
	return {
		usersEmailUnique: unique("users_email_unique").on(table.email),
		usersIdNotNull: check("users_id_not_null", sql`NOT NULL id`),
		usersEmailNotNull: check("users_email_not_null", sql`NOT NULL email`),
		usersDisplayNameNotNull: check("users_display_name_not_null", sql`NOT NULL display_name`),
		usersAuthHashNotNull: check("users_auth_hash_not_null", sql`NOT NULL auth_hash`),
		usersAuthSaltNotNull: check("users_auth_salt_not_null", sql`NOT NULL auth_salt`),
		usersAuthKdfNotNull: check("users_auth_kdf_not_null", sql`NOT NULL auth_kdf`),
		usersPublicKeyJwkNotNull: check("users_public_key_jwk_not_null", sql`NOT NULL public_key_jwk`),
		usersKeyAlgoNotNull: check("users_key_algo_not_null", sql`NOT NULL key_algo`),
		usersWrappedPrivateKeyNotNull: check("users_wrapped_private_key_not_null", sql`NOT NULL wrapped_private_key`),
		usersWrappedPrivateKeyIvNotNull: check("users_wrapped_private_key_iv_not_null", sql`NOT NULL wrapped_private_key_iv`),
		usersPrivateKeyKdfNotNull: check("users_private_key_kdf_not_null", sql`NOT NULL private_key_kdf`),
		usersPrivateKeyKdfParamsNotNull: check("users_private_key_kdf_params_not_null", sql`NOT NULL private_key_kdf_params`),
		usersCreatedAtNotNull: check("users_created_at_not_null", sql`NOT NULL created_at`),
		usersTotpEnabledNotNull: check("users_totp_enabled_not_null", sql`NOT NULL totp_enabled`),
	}
});
