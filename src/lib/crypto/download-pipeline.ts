import { zipSync } from 'fflate';
import { fromBase64 } from './encoding';
import { unwrapFileKey } from './key-encryption';
import { createSha256Stream, decryptBlob, decryptChunk, deriveChunkNonce } from './file-encryption';
import type { FileAlgo, KeyAlgo } from './types';

/** Shape returned by GET /api/files (list). */
export interface EncryptedFileRecord {
	id: string;
	versionOf?: string;
	versionNumber?: number;
	chunkSizeBytes?: number;
	archivedAt?: string;
	contentUpdatedAt?: string;
	replacesFileId?: string | null;
	baseVersion?: number | null;
	thumbnail?: { iv: string; ciphertextSha256: string; sizeBytes: number } | null;
	fileAlgo: FileAlgo;
	fileIv: string; // base64
	keyAlgo: KeyAlgo;
	wrappedFileKey: string; // base64
	keyWrapIv: string | null; // base64, ECDH only
	keyWrapEphemeralPublicKeyJwk: JsonWebKey | null; // ECDH only
	totalChunks: number;
	ciphertextSha256?: string;
	ciphertextSizeBytes?: number;
	uploadStatus?: 'uploading' | 'complete';
	createdAt?: string;
	deletedAt?: string | null;
	metadata: { encryptedBlob: string; iv: string; algo: FileAlgo; strengthLabel?: string } | null;
}

export interface DecryptedMetadata {
	name: string;
	uploadName?: string;
	mimeType: string;
	size: number;
	/** Folder the file lives in (null / absent = vault root). Lives inside the encrypted blob. */
	folderId?: string | null;
}

export interface DownloadProgress {
	phase: 'fetching' | 'verifying' | 'decrypting' | 'done';
	percent: number;
}

/** How to fetch one ciphertext chunk. Defaults to the authenticated per-user
 * route; the public share flow supplies a different one pointing at
 * /api/share/[token]/chunks/[index] instead. */
export type ChunkFetcher = (index: number) => Promise<Response>;

function defaultChunkFetcher(record: EncryptedFileRecord): ChunkFetcher {
	return record.versionOf
		? (index) => fetch(`/api/files/${record.versionOf}/versions/${record.id}/chunks/${index}`)
		: (index) => fetch(`/api/files/${record.id}/chunks/${index}?revision=${record.versionNumber ?? 1}`);
}

/**
 * Unwraps the per-file symmetric key using the caller's private key. Same
 * algorithm the file was wrapped with at upload time — RSA-OAEP needs only
 * the private key; ECDH needs the stored ephemeral public key + wrap IV to
 * redo the shared-secret derivation.
 */
export async function unwrapRecordFileKey(
	record: EncryptedFileRecord,
	privateKey: CryptoKey
): Promise<Uint8Array> {
	if (record.keyAlgo === 'RSA-OAEP') {
		return unwrapFileKey({ wrapped: fromBase64(record.wrappedFileKey), algo: 'RSA-OAEP' }, privateKey);
	}

	if (!record.keyWrapIv || !record.keyWrapEphemeralPublicKeyJwk) {
		throw new Error('Missing ECDH wrap material for this file — it may have been uploaded incorrectly');
	}

	return unwrapFileKey(
		{
			wrapped: fromBase64(record.wrappedFileKey),
			algo: 'ECDH-P256',
			iv: fromBase64(record.keyWrapIv),
			ephemeralPublicKeyJwk: record.keyWrapEphemeralPublicKeyJwk
		},
		privateKey
	);
}

/** Decrypts just the filename/mime/size blob — cheap, used for file listings. */
export async function decryptRecordMetadata(
	record: EncryptedFileRecord,
	fileKey: Uint8Array
): Promise<DecryptedMetadata | null> {
	if (!record.metadata) return null;
	const plaintext = await decryptBlob(
		fromBase64(record.metadata.encryptedBlob),
		fileKey,
		record.metadata.algo,
		fromBase64(record.metadata.iv)
	);
	return JSON.parse(new TextDecoder().decode(plaintext));
}

// ---------------------------------------------------------------------------
// Streaming decrypt
// ---------------------------------------------------------------------------

/**
 * Where decrypted bytes go. `commit` is only called after the whole-file
 * integrity hash has been verified; on ANY failure `abort` is called so a
 * sink backed by a real file on disk can discard the partial output rather
 * than leave a half-written (or unverified) file behind.
 */
export interface PlaintextSink {
	write(chunk: Uint8Array): void | Promise<void>;
	commit(): void | Promise<void>;
	abort(): void | Promise<void>;
}

/** Collects plaintext in memory; `toBlob()` after a successful run. */
export function createBlobSink(mimeType = 'application/octet-stream') {
	let parts: Uint8Array[] = [];
	const sink: PlaintextSink = {
		write(chunk) {
			parts.push(chunk);
		},
		commit() {},
		abort() {
			parts = [];
		}
	};
	return { sink, toBlob: () => new Blob(parts as BlobPart[], { type: mimeType }) };
}

/** True where the File System Access API can stream a download straight to disk (Chromium browsers). */
export function canStreamToDisk(): boolean {
	return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * Opens a save dialog and returns a sink that writes to the chosen file.
 * MUST be called directly from a click handler (the picker needs a user
 * gesture) — i.e. before any long-running await. Returns null if the user
 * cancels. Memory stays flat regardless of file size.
 */
export async function createDiskSink(suggestedName: string, mimeType?: string): Promise<PlaintextSink | null> {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const handle = await (window as any).showSaveFilePicker({
			suggestedName,
			types: mimeType ? [{ description: 'File', accept: { [mimeType]: [] } }] : undefined
		});
		const writable = await handle.createWritable();
		return {
			write: (chunk) => writable.write(chunk),
			commit: () => writable.close(),
			abort: () => writable.abort().catch(() => {})
		};
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') return null;
		throw err;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchCipherChunk(fetchChunk: ChunkFetcher, index: number, total: number): Promise<Uint8Array> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetchChunk(index);
			if (!res.ok) {
				const err = new Error(`Failed to fetch chunk ${index + 1} of ${total}`);
				// 4xx = the request itself is wrong (auth, trashed, expired link) — retrying won't help.
				if (res.status >= 400 && res.status < 500) throw Object.assign(err, { fatal: true });
				throw err;
			}
			const { chunk } = await res.json();
			return fromBase64(chunk);
		} catch (err) {
			lastError = err;
			if ((err as { fatal?: boolean }).fatal) break;
			await sleep(400 * 2 ** attempt);
		}
	}
	throw lastError;
}

const PREFETCH = 3;

/**
 * Fetches, hash-checks and decrypts a file chunk by chunk into `sink`,
 * holding only a few chunks in memory at a time. The running SHA-256 over
 * the ciphertext is compared with the stored hash before `commit()`.
 */
export async function decryptFileToSink(
	record: EncryptedFileRecord,
	fileKey: Uint8Array,
	sink: PlaintextSink,
	opts: { fetchChunk?: ChunkFetcher; onProgress?: (p: DownloadProgress) => void } = {}
): Promise<void> {
	const fetchChunk = opts.fetchChunk ?? defaultChunkFetcher(record);
	const { onProgress } = opts;

	// A missing hash means the upload's finalize step never completed —
	// treat that as untrustworthy rather than silently skipping verification.
	if (!record.ciphertextSha256) {
		throw new Error(
			'This file has no integrity hash on record, which means its upload never finished. It cannot be safely decrypted — delete it and upload it again.'
		);
	}

	const baseNonce = fromBase64(record.fileIv);
	const hasher = await createSha256Stream();
	const inflight = new Map<number, Promise<Uint8Array>>();
	const ensure = (i: number) => {
		if (i < record.totalChunks && !inflight.has(i)) {
			const p = fetchCipherChunk(fetchChunk, i, record.totalChunks);
			p.catch(() => {}); // surfaced when awaited below
			inflight.set(i, p);
		}
	};

	try {
		for (let i = 0; i < record.totalChunks; i++) {
			for (let k = 0; k < PREFETCH; k++) ensure(i + k);
			const cipher = await inflight.get(i)!;
			inflight.delete(i);

			hasher.update(cipher);
			const plain = await decryptChunk(cipher, fileKey, record.fileAlgo, deriveChunkNonce(baseNonce, i));
			await sink.write(plain);
			onProgress?.({ phase: 'decrypting', percent: ((i + 1) / record.totalChunks) * 97 });
		}

		onProgress?.({ phase: 'verifying', percent: 98 });
		if (hasher.digestHex() !== record.ciphertextSha256) {
			throw new Error('Integrity check failed — ciphertext hash does not match. File may be corrupted or tampered with.');
		}
		await sink.commit();
		onProgress?.({ phase: 'done', percent: 100 });
	} catch (err) {
		await sink.abort();
		throw err;
	}
}

/**
 * Fetches every ciphertext chunk for a file, verifies integrity, decrypts
 * each chunk, and returns the reassembled plaintext as a Blob ready to
 * save. Runs entirely in the browser — the server only ever handed back
 * ciphertext bytes. `fetchChunk` defaults to the authenticated per-file
 * route; pass a different one for the public share flow.
 */
export async function downloadAndDecryptFile(
	record: EncryptedFileRecord,
	fileKey: Uint8Array,
	fetchChunk: ChunkFetcher = defaultChunkFetcher(record),
	onProgress?: (p: DownloadProgress) => void
): Promise<{ blob: Blob; metadata: DecryptedMetadata | null }> {
	const metadata = await decryptRecordMetadata(record, fileKey);
	const { sink, toBlob } = createBlobSink(metadata?.mimeType || 'application/octet-stream');
	await decryptFileToSink(record, fileKey, sink, { fetchChunk, onProgress });
	return { blob: toBlob(), metadata };
}

/**
 * Downloads the file WITHOUT decrypting it — verified ciphertext plus a
 * manifest with everything needed to decrypt it later (offline, or with a
 * different tool), bundled into a single .zip so there's one download,
 * not two files a person has to keep track of together.
 */
export async function downloadRawCiphertext(
	record: EncryptedFileRecord,
	fetchChunk: ChunkFetcher = defaultChunkFetcher(record),
	onProgress?: (p: DownloadProgress) => void
): Promise<{ archive: Blob }> {
	if (!record.ciphertextSha256) {
		throw new Error(
			'This file has no integrity hash on record, which means its upload never finished. It cannot be safely exported — delete it and upload it again.'
		);
	}
	const hasher = await createSha256Stream();
	const cipherChunks: Uint8Array[] = [];
	for (let i = 0; i < record.totalChunks; i++) {
		onProgress?.({ phase: 'fetching', percent: (i / record.totalChunks) * 90 });
		const chunk = await fetchCipherChunk(fetchChunk, i, record.totalChunks);
		hasher.update(chunk);
		cipherChunks.push(chunk);
	}
	onProgress?.({ phase: 'verifying', percent: 95 });
	if (hasher.digestHex() !== record.ciphertextSha256) {
		throw new Error('Integrity check failed — ciphertext hash does not match. File may be corrupted or tampered with.');
	}

	const combined = new Uint8Array(cipherChunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const c of cipherChunks) {
		combined.set(c, offset);
		offset += c.length;
	}

	const manifest = {
		fileId: record.id,
		fileAlgo: record.fileAlgo,
		fileIv: record.fileIv,
		keyAlgo: record.keyAlgo,
		wrappedFileKey: record.wrappedFileKey,
		keyWrapIv: record.keyWrapIv,
		keyWrapEphemeralPublicKeyJwk: record.keyWrapEphemeralPublicKeyJwk,
		ciphertextSha256: record.ciphertextSha256,
		totalChunks: record.totalChunks,
		metadata: record.metadata,
		note: "This manifest plus the matching .enc file are needed to decrypt this file later. The wrapped key inside is still encrypted and useless without the owning account's private key."
	};
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

	const zipped = zipSync(
		{
			'file.enc': combined,
			'manifest.json': manifestBytes
		},
		{ level: 0 } // ciphertext is already high-entropy — compression would only cost time, not space
	);

	onProgress?.({ phase: 'done', percent: 100 });
	return { archive: new Blob([zipped as BlobPart], { type: 'application/zip' }) };
}

/**
 * Triggers a browser save-as for a Blob. Revocation of the object URL is
 * deliberately delayed rather than immediate: calling revokeObjectURL()
 * synchronously right after click() is a known race condition — on some
 * browsers/systems the download hasn't finished reading from the blob URL
 * yet, and revoking it early can silently truncate the saved file. The
 * click() call itself is synchronous and reliably initiates the download,
 * so a short delay before cleanup costs nothing and removes the race.
 */
export function triggerBrowserDownload(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}
