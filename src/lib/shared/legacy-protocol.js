/**
 * Immutable v1 cryptographic domains and readers for pre-rebrand data.
 * Changing a derivation label would make existing ciphertext or recovery keys
 * unreadable. Keep these values independent of OverDrive's product name.
 */
export const RECOVERY_SALT_V1 = 'endtoend-encrypt/recovery/v1';
export const THUMBNAIL_INFO_V1 = 'e2e-file-thumbnail:v1';
export const TOTP_SALT_V1 = 'e2e-totp';

export const LEGACY_SESSION_COOKIE = 'e2e_session';
export const LEGACY_DEVICE_COOKIE = 'e2e_device';
export const LEGACY_SHARE_DOWNLOAD_AUDIENCE = 'e2e-share-download';
export const LEGACY_BACKUP_FORMAT = 'e2e-database';
export const LEGACY_BACKUP_MAGIC = 'E2E-DB-BACKUP-1\n';
