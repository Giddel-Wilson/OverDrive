import { encryptBlob } from './file-encryption';
import { toBase64 } from './encoding';
import { unwrapRecordFileKey, decryptRecordMetadata, type EncryptedFileRecord } from './download-pipeline';

/** Restore content and its MIME/size while preserving the current name and folder. */
export async function restoreFileVersion(current: EncryptedFileRecord, version: EncryptedFileRecord, privateKey: CryptoKey) {
	if (version.versionOf !== current.id) throw new Error('That version belongs to a different file');
	const [currentKey, versionKey] = await Promise.all([unwrapRecordFileKey(current, privateKey), unwrapRecordFileKey(version, privateKey)]);
	const [currentMetadata, oldMetadata] = await Promise.all([decryptRecordMetadata(current, currentKey), decryptRecordMetadata(version, versionKey)]);
	if (!currentMetadata || !oldMetadata) throw new Error('This file is missing encrypted metadata');
	const metadata = { ...oldMetadata, name: currentMetadata.name, folderId: currentMetadata.folderId ?? null };
	const encrypted = await encryptBlob(new TextEncoder().encode(JSON.stringify(metadata)), versionKey, version.metadata!.algo);
	const response = await fetch(`/api/files/${current.id}/versions/${version.id}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ baseVersion: current.versionNumber ?? 1, metadata: { encryptedBlob: toBase64(encrypted.ciphertext), iv: toBase64(encrypted.iv) } })
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(body.message ?? 'Could not restore this version');
	}
	return response.json();
}
