import { describe, it, expect, afterEach, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { generateEcdhKeypair, generateRsaKeypair } from '../key-encryption';
import { encryptAndUploadFile, resumeUpload, UploadInterruptedError, type UploadProgress } from '../upload-pipeline';
import {
	createBlobSink,
	decryptFileToSink,
	decryptRecordMetadata,
	unwrapRecordFileKey,
	type EncryptedFileRecord,
	type PlaintextSink
} from '../download-pipeline';
import { createFolderPayload } from '../vault';
import { exportVault } from '../export-vault';
import { CHUNK_SIZE_BYTES } from '../types';
import { installFakeServer, randomBytes } from './fake-server';

const MiB = 1024 * 1024;
const makeFile = (size: number, name = 'data.bin', type = 'application/octet-stream') =>
	new File([randomBytes(size) as BlobPart], name, { type });

async function decryptAll(record: EncryptedFileRecord, privateKey: CryptoKey) {
	const key = await unwrapRecordFileKey(record, privateKey);
	const meta = await decryptRecordMetadata(record, key);
	const { sink, toBlob } = createBlobSink();
	await decryptFileToSink(record, key, sink);
	return { meta, bytes: new Uint8Array(await toBlob().arrayBuffer()) };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['AES-GCM', 'ChaCha20-Poly1305'] as const)('direct upload → streaming download (%s)', (fileAlgo) => {
	it('round-trips a multi-chunk file through presigned URLs, byte for byte', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const file = makeFile(2 * CHUNK_SIZE_BYTES + 137, 'movie.mp4', 'video/mp4');
		const progress: UploadProgress[] = [];

		const { fileId } = await encryptAndUploadFile({
			file,
			recipientPublicKey: kp.publicKey,
			choice: { fileAlgo, keyAlgo: 'ECDH-P256' },
			folderId: 'folder-1',
			onProgress: (p) => progress.push(p)
		});

		expect(server.stats.directPuts).toBe(3);
		expect(server.stats.relayPuts).toBe(0);
		expect(server.stats.presignCalls).toBe(1); // one batch covers all three chunks
		expect(progress.at(-1)).toMatchObject({ phase: 'done', percent: 100 });
		expect(progress.some((p) => p.mode === 'direct')).toBe(true);

		const record = server.record(fileId);
		// Server only ever held ciphertext + an encrypted metadata blob.
		expect(JSON.stringify(server.files.get(fileId)!.init)).not.toContain('movie.mp4');

		const { meta, bytes } = await decryptAll(record, kp.privateKey);
		expect(meta).toEqual({ name: 'movie.mp4', mimeType: 'video/mp4', size: file.size, folderId: 'folder-1' });
		expect(Buffer.compare(bytes, new Uint8Array(await file.arrayBuffer()))).toBe(0);
	});
});

describe('edge cases', () => {
	it('handles an empty file (one empty chunk, still authenticated)', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const file = new File([], 'empty.txt', { type: 'text/plain' });
		const { fileId } = await encryptAndUploadFile({ file, recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' } });
		expect(server.files.get(fileId)!.init.totalChunks).toBe(1);
		expect(server.files.get(fileId)!.init.ciphertextSizeBytesEstimate).toBe(16);
		const { bytes, meta } = await decryptAll(server.record(fileId), kp.privateKey);
		expect(bytes.length).toBe(0);
		expect(meta?.name).toBe('empty.txt');
	});

	it('works with RSA-OAEP-wrapped keys too', async () => {
		const server = installFakeServer();
		const kp = await generateRsaKeypair();
		const file = makeFile(1000);
		const { fileId } = await encryptAndUploadFile({ file, recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'RSA-OAEP' } });
		const { bytes } = await decryptAll(server.record(fileId), kp.privateKey);
		expect(Buffer.compare(bytes, new Uint8Array(await file.arrayBuffer()))).toBe(0);
	}, 30_000);

	it('rejects files over the size limit before talking to the server', async () => {
		installFakeServer();
		const kp = await generateEcdhKeypair();
		const huge = { size: 6 * 1024 * MiB, name: 'x', type: '' } as unknown as File;
		await expect(
			encryptAndUploadFile({ file: huge, recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' } })
		).rejects.toThrow(/limit/);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('resume and fallback', () => {
	it('keeps an interrupted upload and resumes it, uploading ONLY the missing chunks', async () => {
		// Chunk 2 fails every time during the first run; chunks 0 and 1 land.
		let healthy = false;
		const server = installFakeServer({ failDirectPut: (_f, index) => (!healthy && index === 2 ? 'http500' : null) });
		const kp = await generateEcdhKeypair();
		const file = makeFile(3 * CHUNK_SIZE_BYTES - 10, 'big.bin');

		let fileId = '';
		await encryptAndUploadFile({
			file,
			recipientPublicKey: kp.publicKey,
			choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' },
			retryBaseDelayMs: 1
		}).catch((e) => {
			expect(e).toBeInstanceOf(UploadInterruptedError);
			fileId = (e as UploadInterruptedError).fileId;
		});
		expect(fileId).not.toBe('');
		expect([...server.files.get(fileId)!.chunks.keys()].sort()).toEqual([0, 1]);
		expect(server.files.get(fileId)!.complete).toBe(false);

		// Resume with the wrong file is refused.
		await expect(
			resumeUpload({ file: makeFile(3 * CHUNK_SIZE_BYTES - 10, 'other.bin'), record: server.record(fileId), privateKey: kp.privateKey })
		).rejects.toThrow(/not the same file/);

		healthy = true;
		const putsBefore = server.stats.directPuts;
		const progress: UploadProgress[] = [];
		await resumeUpload({ file, record: server.record(fileId), privateKey: kp.privateKey, onProgress: (p) => progress.push(p), retryBaseDelayMs: 1 });

		expect(server.stats.directPuts - putsBefore).toBe(1); // only chunk 2
		expect(progress.at(-1)).toMatchObject({ phase: 'done', resumedChunks: 2 });
		expect(server.files.get(fileId)!.complete).toBe(true);

		// And the resumed file is byte-identical, with a hash that verifies.
		const { bytes } = await decryptAll(server.record(fileId), kp.privateKey);
		expect(Buffer.compare(bytes, new Uint8Array(await file.arrayBuffer()))).toBe(0);
	});

	it('survives transient failures on a working direct path (retries, no relay)', async () => {
		const server = installFakeServer({ failDirectPut: (_f, index, attempt) => (index === 1 && attempt <= 2 ? 'network' : null) });
		const kp = await generateEcdhKeypair();
		const file = makeFile(2 * CHUNK_SIZE_BYTES);
		const progress: UploadProgress[] = [];
		const { fileId } = await encryptAndUploadFile({
			file,
			recipientPublicKey: kp.publicKey,
			choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' },
			onProgress: (p) => progress.push(p),
			retryBaseDelayMs: 1
		});
		expect(server.stats.relayPuts).toBe(0);
		expect(progress.every((p) => p.mode !== 'relay')).toBe(true);
		const { bytes } = await decryptAll(server.record(fileId), kp.privateKey);
		expect(Buffer.compare(bytes, new Uint8Array(await file.arrayBuffer()))).toBe(0);
	});

	it('falls back to the server relay when direct upload never works (e.g. CORS not configured)', async () => {
		const server = installFakeServer({ failDirectPut: () => 'network' });
		const kp = await generateEcdhKeypair();
		const file = makeFile(2 * CHUNK_SIZE_BYTES + 5);
		const progress: UploadProgress[] = [];
		const { fileId } = await encryptAndUploadFile({
			file,
			recipientPublicKey: kp.publicKey,
			choice: { fileAlgo: 'ChaCha20-Poly1305', keyAlgo: 'ECDH-P256' },
			onProgress: (p) => progress.push(p),
			retryBaseDelayMs: 1
		});
		expect(server.stats.directPuts).toBe(0);
		expect(server.stats.relayPuts).toBe(3);
		expect(progress.at(-1)?.mode).toBe('relay');
		const { bytes } = await decryptAll(server.record(fileId), kp.privateKey);
		expect(Buffer.compare(bytes, new Uint8Array(await file.arrayBuffer()))).toBe(0);
	});

	it('honours an abort signal', async () => {
		installFakeServer();
		const kp = await generateEcdhKeypair();
		const ac = new AbortController();
		ac.abort();
		await expect(
			encryptAndUploadFile({ file: makeFile(1000), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' }, signal: ac.signal })
		).rejects.toBeInstanceOf(UploadInterruptedError);
	});
});

describe('integrity on download', () => {
	it('aborts the sink (never commits) when stored ciphertext was tampered with', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const { fileId } = await encryptAndUploadFile({ file: makeFile(5000), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' } });
		server.files.get(fileId)!.chunks.get(0)![10] ^= 0xff;

		const record = server.record(fileId);
		const key = await unwrapRecordFileKey(record, kp.privateKey);
		const events: string[] = [];
		const sink: PlaintextSink = { write: () => void events.push('write'), commit: () => void events.push('commit'), abort: () => void events.push('abort') };
		await expect(decryptFileToSink(record, key, sink)).rejects.toThrow();
		expect(events).toContain('abort');
		expect(events).not.toContain('commit');
	});

	it('refuses to decrypt a file whose upload never finalized (no hash)', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const { fileId } = await encryptAndUploadFile({ file: makeFile(100), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' } });
		const record = { ...server.record(fileId), ciphertextSha256: '' };
		const key = await unwrapRecordFileKey(record, kp.privateKey);
		await expect(decryptFileToSink(record, key, createBlobSink().sink)).rejects.toThrow(/never finished/);
	});
});

describe('full vault export', () => {
	it('decrypts everything into a zip that mirrors the folder tree (and survives name clashes)', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const mkFolder = async (id: string, name: string, parentId: string | null) => ({
			id,
			...(await createFolderPayload(name, parentId, 'ECDH-P256', kp.publicKey))
		});
		const folders = [await mkFolder('f-docs', 'Docs', null), await mkFolder('f-tax', 'Tax: 2025?', 'f-docs'), await mkFolder('f-empty', 'Empty', null)];

		const upload = async (name: string, content: string, folderId: string | null) => {
			const { fileId } = await encryptAndUploadFile({
				file: new File([content], name, { type: 'text/plain' }),
				recipientPublicKey: kp.publicKey,
				choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' },
				folderId
			});
			return server.record(fileId);
		};
		const files = [
			await upload('root.txt', 'in root', null),
			await upload('notes.txt', 'docs one', 'f-docs'),
			await upload('notes.txt', 'docs two', 'f-docs'), // same name, same folder
			await upload('return.txt', 'deep', 'f-tax')
		];

		const { sink, toBlob } = createBlobSink('application/zip');
		const progress: string[] = [];
		const result = await exportVault({ files, folders, privateKey: kp.privateKey, sink, onProgress: (p) => progress.push(p.phase) });

		expect(result).toEqual({ exported: 4, failed: [] });
		expect(progress[0]).toBe('preparing');
		expect(progress.at(-1)).toBe('done');

		const zip = unzipSync(new Uint8Array(await toBlob().arrayBuffer()));
		expect(strFromU8(zip['root.txt'])).toBe('in root');
		expect(strFromU8(zip['Docs/notes.txt'])).toBe('docs one');
		expect(strFromU8(zip['Docs/notes (2).txt'])).toBe('docs two');
		expect(strFromU8(zip['Docs/Tax_ 2025_/return.txt'])).toBe('deep');
		expect(Object.keys(zip)).toContain('Empty/');
	});

	it('exports just one folder subtree (the "download folder" action), rooted at that folder', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const mk = async (id: string, name: string, parentId: string | null) => ({ id, ...(await createFolderPayload(name, parentId, 'ECDH-P256', kp.publicKey)) });
		const docs = await mk('f-docs', 'Docs', null);
		const sub = await mk('f-sub', 'Sub', 'f-docs');
		const other = await mk('f-other', 'Other', null);
		const up = async (name: string, content: string, folderId: string | null) => {
			const { fileId } = await encryptAndUploadFile({ file: new File([content], name), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' }, folderId });
			return server.record(fileId);
		};
		const inDocs = await up('a.txt', 'A', 'f-docs');
		const inSub = await up('b.txt', 'B', 'f-sub');
		await up('c.txt', 'not in the folder', 'f-other');

		// The dashboard passes only the subtree's records, exactly like this.
		const { sink, toBlob } = createBlobSink();
		const res = await exportVault({ files: [inDocs, inSub], folders: [docs, sub], privateKey: kp.privateKey, sink });
		expect(res).toEqual({ exported: 2, failed: [] });
		const names = Object.keys(unzipSync(new Uint8Array(await toBlob().arrayBuffer()))).sort();
		expect(names).toEqual(['Docs/', 'Docs/Sub/', 'Docs/Sub/b.txt', 'Docs/a.txt']);

		// A nested folder downloaded on its own is rooted at itself, not at the vault root.
		const nested = createBlobSink();
		await exportVault({ files: [inSub], folders: [sub], privateKey: kp.privateKey, sink: nested.sink });
		expect(Object.keys(unzipSync(new Uint8Array(await nested.toBlob().arrayBuffer()))).sort()).toEqual(['Sub/', 'Sub/b.txt']);
		void other;
	});

	it('reports a corrupted file instead of failing the whole export', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const up = async (name: string) => {
			const { fileId } = await encryptAndUploadFile({ file: new File([name + ' contents'], name), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' } });
			return fileId;
		};
		const good = await up('good.txt');
		const bad = await up('bad.txt');
		server.files.get(bad)!.chunks.get(0)![3] ^= 1;

		const { sink, toBlob } = createBlobSink();
		const result = await exportVault({ files: [server.record(good), server.record(bad)], folders: [], privateKey: kp.privateKey, sink });
		expect(result.exported).toBe(1);
		expect(result.failed.map((f) => f.path)).toEqual(['bad.txt']);

		const zip = unzipSync(new Uint8Array(await toBlob().arrayBuffer()));
		expect(strFromU8(zip['good.txt'])).toBe('good.txt contents');
		expect(strFromU8(zip['EXPORT-REPORT.txt'])).toContain('bad.txt');
	});

	it('produces a valid ZIP64 archive when forced', async () => {
		const server = installFakeServer();
		const kp = await generateEcdhKeypair();
		const { fileId } = await encryptAndUploadFile({ file: new File(['zip64 body'], 'a.txt'), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'ChaCha20-Poly1305', keyAlgo: 'ECDH-P256' } });
		const { sink, toBlob } = createBlobSink();
		await exportVault({ files: [server.record(fileId)], folders: [], privateKey: kp.privateKey, sink, zip64ForTesting: true });
		expect(strFromU8(unzipSync(new Uint8Array(await toBlob().arrayBuffer()))['a.txt'])).toBe('zip64 body');
	});
});
