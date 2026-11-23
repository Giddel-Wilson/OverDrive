import { describe, it, expect } from 'vitest';
import { generateEcdhKeypair, generateRsaKeypair } from '../key-encryption';
import {
	ancestorIds,
	collectSubtree,
	createFolderPayload,
	decryptFolderMeta,
	descendantFolderIds,
	folderPath,
	isValidFolderMoveTarget,
	reencryptFolderMeta,
	reencryptFileMeta,
	searchEntries,
	sortEntries,
	type FolderMap,
	type FolderRecord,
	type NamedEntry
} from '../vault';
import { generateFileKey, encryptBlob } from '../file-encryption';
import { wrapFileKey } from '../key-encryption';
import { toBase64 } from '../encoding';
import { decryptRecordMetadata, unwrapRecordFileKey, type EncryptedFileRecord } from '../download-pipeline';

const tree = (): FolderMap =>
	new Map([
		['a', { name: 'Docs', parentId: null }],
		['b', { name: 'Taxes', parentId: 'a' }],
		['c', { name: '2025', parentId: 'b' }],
		['d', { name: 'Photos', parentId: null }]
	]);

describe('folder tree helpers', () => {
	it('builds breadcrumb paths root → leaf and survives cycles', () => {
		expect(folderPath('c', tree()).map((f) => f.name)).toEqual(['Docs', 'Taxes', '2025']);
		expect(folderPath(null, tree())).toEqual([]);
		const cyclic: FolderMap = new Map([
			['x', { name: 'X', parentId: 'y' }],
			['y', { name: 'Y', parentId: 'x' }]
		]);
		expect(folderPath('x', cyclic).length).toBeLessThanOrEqual(2);
	});

	it('finds descendants and ancestors', () => {
		expect(descendantFolderIds('a', tree()).sort()).toEqual(['b', 'c']);
		expect(descendantFolderIds('d', tree())).toEqual([]);
		expect(ancestorIds('c', tree())).toEqual(['b', 'a']);
		expect(ancestorIds('a', tree())).toEqual([]);
	});

	it("won't move a folder into itself or its own subtree", () => {
		expect(isValidFolderMoveTarget('a', null, tree())).toBe(true);
		expect(isValidFolderMoveTarget('a', 'a', tree())).toBe(false);
		expect(isValidFolderMoveTarget('a', 'c', tree())).toBe(false);
		expect(isValidFolderMoveTarget('c', 'd', tree())).toBe(true);
	});

	it('collects a folder subtree including files', () => {
		const files = [
			{ id: 'f1', folderId: 'a' },
			{ id: 'f2', folderId: 'c' },
			{ id: 'f3', folderId: 'd' },
			{ id: 'f4', folderId: null }
		];
		const sub = collectSubtree('a', tree(), files);
		expect(sub.folderIds.sort()).toEqual(['a', 'b', 'c']);
		expect(sub.fileIds.sort()).toEqual(['f1', 'f2']);
	});

	it('sorts folders first, natural name order, and searches case-insensitively', () => {
		const entries: NamedEntry[] = [
			{ kind: 'file', id: '1', name: 'report10.pdf', parentId: null, size: 5, createdAt: '2026-01-02' },
			{ kind: 'file', id: '2', name: 'report2.pdf', parentId: null, size: 50, createdAt: '2026-01-03' },
			{ kind: 'folder', id: '3', name: 'zeta', parentId: null }
		];
		expect(sortEntries(entries, 'name').map((e) => e.id)).toEqual(['3', '2', '1']);
		expect(sortEntries(entries, 'size').map((e) => e.id)).toEqual(['3', '2', '1']);
		expect(sortEntries(entries, 'newest').map((e) => e.id)).toEqual(['3', '2', '1']);
		expect(searchEntries('REPORT2', entries).map((e) => e.id)).toEqual(['2']);
		expect(searchEntries('   ', entries)).toEqual([]);
	});
});

describe.each([
	['ECDH-P256', generateEcdhKeypair],
	['RSA-OAEP', generateRsaKeypair]
] as const)('encrypted folder + metadata round trips (%s)', (keyAlgo, gen) => {
	// 4096-bit RSA generation can exceed the default timeout under parallel load.
	const roundTripTimeoutMs = keyAlgo === 'RSA-OAEP' ? 30_000 : 5_000;
	it('creates, decrypts, renames and moves a folder without the server learning names', async () => {
		const kp = await gen();
		const payload = await createFolderPayload('Tax returns', null, keyAlgo, kp.publicKey);
		expect(payload.encryptedBlob).not.toContain('Tax');
		const record: FolderRecord = { id: 'f1', ...payload } as FolderRecord;

		expect(await decryptFolderMeta(record, kp.privateKey)).toEqual({ name: 'Tax returns', parentId: null });

		const renamed = await reencryptFolderMeta(record, kp.privateKey, { name: 'Taxes' });
		const after = await decryptFolderMeta({ ...record, ...renamed }, kp.privateKey);
		expect(after).toEqual({ name: 'Taxes', parentId: null });

		const moved = await reencryptFolderMeta({ ...record, ...renamed }, kp.privateKey, { parentId: 'parent-1' });
		expect(await decryptFolderMeta({ ...record, ...moved }, kp.privateKey)).toEqual({ name: 'Taxes', parentId: 'parent-1' });
	}, roundTripTimeoutMs);

	it('renames / moves a file by re-encrypting only its metadata blob', async () => {
		const kp = await gen();
		const fileKey = generateFileKey();
		const meta = { name: 'a.txt', mimeType: 'text/plain', size: 3, folderId: null };
		const { ciphertext, iv } = await encryptBlob(new TextEncoder().encode(JSON.stringify(meta)), fileKey, 'AES-GCM');
		const wrapped = await wrapFileKey(fileKey, keyAlgo, kp.publicKey);
		const record: EncryptedFileRecord = {
			id: 'x',
			fileAlgo: 'AES-GCM',
			fileIv: '',
			keyAlgo,
			wrappedFileKey: toBase64(wrapped.wrapped),
			keyWrapIv: wrapped.iv ? toBase64(wrapped.iv) : null,
			keyWrapEphemeralPublicKeyJwk: (wrapped.ephemeralPublicKeyJwk as JsonWebKey) ?? null,
			totalChunks: 1,
			metadata: { encryptedBlob: toBase64(ciphertext), iv: toBase64(iv), algo: 'AES-GCM' }
		};

		const patch = await reencryptFileMeta(record, kp.privateKey, { name: 'b.txt', folderId: 'folder-9' });
		const updated: EncryptedFileRecord = { ...record, metadata: { ...record.metadata!, ...patch } };
		const key = await unwrapRecordFileKey(updated, kp.privateKey);
		expect(await decryptRecordMetadata(updated, key)).toEqual({ name: 'b.txt', mimeType: 'text/plain', size: 3, folderId: 'folder-9' });
	}, roundTripTimeoutMs);
});
