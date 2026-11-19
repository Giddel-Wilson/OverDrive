import { CHUNK_SIZE_BYTES, type FileAlgo, type KeyAlgo } from './types';
import {
	createSha256Stream,
	deriveChunkNonce,
	encryptBlob,
	encryptChunk,
	generateFileKey,
	newBaseNonce
} from './file-encryption';
import { wrapFileKey } from './key-encryption';
import { computeStrengthRating } from './strength';
import { toBase64, fromBase64 } from './encoding';
import { decryptRecordMetadata, unwrapRecordFileKey, type EncryptedFileRecord } from './download-pipeline';
import { MAX_FILE_SIZE_BYTES, PRESIGN_BATCH_SIZE, UPLOAD_CONCURRENCY, formatBytes } from '../shared/limits';

export interface EncryptionChoice {
	fileAlgo: FileAlgo;
	keyAlgo: KeyAlgo;
}

export interface UploadProgress {
	phase: 'encrypting' | 'uploading' | 'finalizing' | 'done' | 'error';
	percent: number;
	bytesDone: number;
	bytesTotal: number;
	/** 'direct' = browser → storage via presigned URLs; 'relay' = fallback through the app server. */
	mode?: 'direct' | 'relay';
	/** Chunks that were already in storage and skipped (resume). */
	resumedChunks?: number;
}

/**
 * Thrown when an upload stops after the file row was created. The partial
 * upload is kept server-side and shows up under "Incomplete uploads", so
 * the user can resume it instead of starting over.
 */
export class UploadInterruptedError extends Error {
	constructor(
		message: string,
		public readonly fileId: string
	) {
		super(message);
		this.name = 'UploadInterruptedError';
	}
}

interface UploadFileOptions {
	file: File;
	recipientPublicKey: CryptoKey;
	choice: EncryptionChoice;
	/** Folder to place the file in (null = vault root). Stored inside the encrypted metadata. */
	folderId?: string | null;
	onProgress?: (p: UploadProgress) => void;
	signal?: AbortSignal;
	/** Base delay for exponential backoff between retries. Tests lower it. */
	retryBaseDelayMs?: number;
}

const MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
	constructor(public readonly status: number) {
		super(`Storage responded with HTTP ${status}`);
	}
}

async function postJson(body: unknown, errorMessage: string) {
	const res = await fetch('/api/files/upload', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.message ?? errorMessage);
	}
	return res.json();
}

/**
 * Presigned-URL cache. URLs are requested a batch at a time (one round
 * trip covers PRESIGN_BATCH_SIZE chunks) and refreshed on demand if one
 * expires or is rejected.
 */
function createPresigner(fileId: string, totalChunks: number, skip: Set<number>) {
	const urls = new Map<number, string>();
	const loading = new Map<number, Promise<void>>();

	function load(batch: number): Promise<void> {
		const existing = loading.get(batch);
		if (existing) return existing;
		const indexes: number[] = [];
		for (let i = batch * PRESIGN_BATCH_SIZE; i < Math.min((batch + 1) * PRESIGN_BATCH_SIZE, totalChunks); i++) {
			if (!skip.has(i)) indexes.push(i);
		}
		const p = (async () => {
			if (indexes.length === 0) return;
			const { urls: fresh } = await postJson({ action: 'presign', fileId, indexes }, 'Could not get upload URLs');
			for (const [k, v] of Object.entries(fresh as Record<string, string>)) urls.set(Number(k), v);
		})().finally(() => loading.delete(batch));
		loading.set(batch, p);
		return p;
	}

	return {
		async get(index: number): Promise<string> {
			if (!urls.has(index)) await load(Math.floor(index / PRESIGN_BATCH_SIZE));
			const url = urls.get(index);
			if (!url) throw new Error('Upload URL missing');
			return url;
		},
		invalidate(index: number) {
			urls.delete(index);
		}
	};
}

interface ChunkRunOptions {
	file: File;
	fileId: string;
	fileKey: Uint8Array;
	baseNonce: Uint8Array;
	fileAlgo: FileAlgo;
	totalChunks: number;
	alreadyUploaded: Set<number>;
	onProgress?: (p: UploadProgress) => void;
	signal?: AbortSignal;
	retryBaseDelayMs?: number;
}

/**
 * The shared engine for new uploads and resumes. Encrypts every chunk in
 * order (so the running SHA-256 over the ciphertext stays correct — chunk
 * encryption is deterministic for a given key + base nonce, which is also
 * what makes resuming possible), uploads the ones storage doesn't have yet
 * with bounded parallelism, then finalizes.
 */
async function runChunkUpload(o: ChunkRunOptions): Promise<void> {
	const { file, fileId, fileKey, baseNonce, fileAlgo, totalChunks, alreadyUploaded, onProgress, signal } = o;
	const retryBase = o.retryBaseDelayMs ?? 500;
	const presigner = createPresigner(fileId, totalChunks, alreadyUploaded);
	const hasher = await createSha256Stream();

	let mode: 'direct' | 'relay' = 'direct';
	let directSucceeded = false;
	let directFailures = 0;
	let bytesDone = 0;
	const resumedChunks = alreadyUploaded.size;

	const report = (phase: UploadProgress['phase']) =>
		onProgress?.({
			phase,
			percent: file.size === 0 ? 0 : Math.min(99, (bytesDone / file.size) * 100),
			bytesDone,
			bytesTotal: file.size,
			mode,
			resumedChunks
		});

	async function putDirect(index: number, cipher: Uint8Array) {
		const url = await presigner.get(index);
		const res = await fetch(url, { method: 'PUT', body: cipher as BufferSource, signal });
		if (!res.ok) {
			if (res.status === 403) presigner.invalidate(index); // likely an expired URL — fetch a fresh one next attempt
			throw new HttpError(res.status);
		}
		directSucceeded = true;
	}

	async function putRelay(index: number, cipher: Uint8Array) {
		const res = await fetch('/api/files/upload', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'X-File-Id': fileId, 'X-Chunk-Index': String(index) },
			body: JSON.stringify({ chunk: toBase64(cipher) }),
			signal
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.message ?? `Failed to upload chunk ${index + 1} of ${totalChunks}`);
		}
	}

	async function uploadChunk(index: number, cipher: Uint8Array, plainLength: number) {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			signal?.throwIfAborted();
			try {
				if (mode === 'direct') await putDirect(index, cipher);
				else await putRelay(index, cipher);
				bytesDone += plainLength;
				report('uploading');
				return;
			} catch (err) {
				if (signal?.aborted) throw err;
				lastError = err;
				if (mode === 'direct') {
					directFailures++;
					// If direct upload has NEVER worked, the likely cause is the bucket's
					// CORS rules (or a blocked network) rather than a blip — switch the
					// rest of this upload to the server relay instead of failing.
					if (!directSucceeded && directFailures >= 2) {
						mode = 'relay';
						report('uploading');
						continue;
					}
				}
				await sleep(Math.min(8000, retryBase * 2 ** attempt) + Math.random() * (retryBase / 2));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(`Chunk ${index + 1} failed to upload`);
	}

	// Bounded concurrency: never more than UPLOAD_CONCURRENCY encrypted
	// chunks alive at once, so memory stays flat for multi-GB files.
	const inflight = new Set<Promise<void>>();
	let firstError: unknown = null;

	for (let i = 0; i < totalChunks && firstError === null; i++) {
		signal?.throwIfAborted();
		while (inflight.size >= UPLOAD_CONCURRENCY && firstError === null) await Promise.race(inflight);
		if (firstError !== null) break;

		const start = i * CHUNK_SIZE_BYTES;
		const end = Math.min(start + CHUNK_SIZE_BYTES, file.size);
		const plain = new Uint8Array(await file.slice(start, end).arrayBuffer());
		const cipher = await encryptChunk(plain, fileKey, fileAlgo, deriveChunkNonce(baseNonce, i));
		hasher.update(cipher);

		if (alreadyUploaded.has(i)) {
			bytesDone += plain.length;
			report('uploading');
			continue;
		}

		let task!: Promise<void>;
		task = uploadChunk(i, cipher, plain.length)
			.catch((err) => {
				firstError ??= err;
			})
			.finally(() => {
				inflight.delete(task);
			});
		inflight.add(task);
	}

	await Promise.all(inflight);
	if (firstError !== null) throw firstError;
	signal?.throwIfAborted();

	report('finalizing');
	await postJson({ action: 'finalize', fileId, ciphertextSha256: hasher.digestHex() }, 'Failed to finalize upload');
	onProgress?.({ phase: 'done', percent: 100, bytesDone: file.size, bytesTotal: file.size, mode, resumedChunks });
}

/**
 * Encrypts a File in fixed-size chunks (so memory stays bounded for large
 * files) and uploads the ciphertext straight to object storage through
 * presigned URLs — the app server (and Vercel's request-size limits) never
 * sit in the data path. Filename / MIME / size / folder are encrypted
 * separately into the file_metadata blob so the server is metadata-blind.
 *
 * If the upload is interrupted after it started, the partial upload is
 * kept and can be continued with resumeUpload().
 */
export async function encryptAndUploadFile({
	file,
	recipientPublicKey,
	choice,
	folderId = null,
	onProgress,
	signal,
	retryBaseDelayMs
}: UploadFileOptions) {
	if (file.size > MAX_FILE_SIZE_BYTES) {
		throw new Error(`File is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_FILE_SIZE_BYTES)}.`);
	}

	const fileKey = generateFileKey();
	const baseNonce = newBaseNonce();
	// An empty file still gets one (empty) chunk so it has an auth tag and a hash.
	const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));

	// 1. Encrypt metadata (filename, mime, size, folder) as its own small blob.
	const metadataPlain = new TextEncoder().encode(
		JSON.stringify({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, folderId })
	);
	const { ciphertext: metaCiphertext, iv: metaIv } = await encryptBlob(metadataPlain, fileKey, choice.fileAlgo);

	// 2. Wrap the file key under the recipient's (usually self) public key.
	const wrappedKey = await wrapFileKey(fileKey, choice.keyAlgo, recipientPublicKey);
	const strength = computeStrengthRating(choice.fileAlgo, choice.keyAlgo);

	// 3. Initiate — the server creates the row (status "uploading") but
	// receives zero plaintext at any point.
	const { fileId } = await postJson(
		{
			action: 'init',
			fileAlgo: choice.fileAlgo,
			keyAlgo: choice.keyAlgo,
			fileIv: toBase64(baseNonce),
			wrappedFileKey: toBase64(wrappedKey.wrapped),
			wrapIv: wrappedKey.iv ? toBase64(wrappedKey.iv) : null,
			ephemeralPublicKeyJwk: wrappedKey.ephemeralPublicKeyJwk ?? null,
			metadata: {
				encryptedBlob: toBase64(metaCiphertext),
				iv: toBase64(metaIv),
				algo: choice.fileAlgo,
				strengthScore: strength.score,
				strengthLabel: strength.label
			},
			totalChunks,
			chunkSizeBytes: CHUNK_SIZE_BYTES,
			ciphertextSizeBytesEstimate: file.size + totalChunks * 16 // + one auth tag per chunk
		},
		'Failed to initialize upload'
	);

	// 4. Encrypt + upload chunks, then finalize.
	try {
		await runChunkUpload({
			file,
			fileId,
			fileKey,
			baseNonce,
			fileAlgo: choice.fileAlgo,
			totalChunks,
			alreadyUploaded: new Set(),
			onProgress,
			signal,
			retryBaseDelayMs
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : 'Upload interrupted';
		throw new UploadInterruptedError(`${reason} — the upload was saved so you can resume it.`, fileId);
	}

	return { fileId, strength };
}

/**
 * Continues an interrupted upload. The user re-selects the same file; the
 * wrapped key stored at init is unwrapped, chunks already in storage are
 * skipped, and — because chunk encryption is deterministic for a given key
 * and base nonce — the rest produces byte-identical ciphertext, so the
 * final hash is still correct.
 */
export async function resumeUpload({
	file,
	record,
	privateKey,
	onProgress,
	signal,
	retryBaseDelayMs
}: {
	file: File;
	record: EncryptedFileRecord;
	privateKey: CryptoKey;
	onProgress?: (p: UploadProgress) => void;
	signal?: AbortSignal;
	retryBaseDelayMs?: number;
}) {
	const fileKey = await unwrapRecordFileKey(record, privateKey);
	const meta = await decryptRecordMetadata(record, fileKey);
	if (!meta || meta.name !== file.name || meta.size !== file.size) {
		throw new Error(`That is not the same file. Select "${meta?.name ?? 'the original file'}" (${formatBytes(meta?.size ?? 0)}) to resume.`);
	}

	const res = await fetch(`/api/files/upload?fileId=${record.id}`);
	if (!res.ok) throw new Error('Could not check upload progress');
	const { uploaded } = (await res.json()) as { uploaded: number[] };

	try {
		await runChunkUpload({
			file,
			fileId: record.id,
			fileKey,
			baseNonce: fromBase64(record.fileIv),
			fileAlgo: record.fileAlgo,
			totalChunks: record.totalChunks,
			alreadyUploaded: new Set(uploaded),
			onProgress,
			signal,
			retryBaseDelayMs
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : 'Upload interrupted';
		throw new UploadInterruptedError(`${reason} — you can resume again.`, record.id);
	}
}

/** Throws away an unfinished upload (and whatever chunks it already stored). */
export async function discardUpload(fileId: string): Promise<void> {
	const res = await fetch(`/api/files/upload?fileId=${fileId}`, { method: 'DELETE' });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.message ?? 'Could not discard the upload');
	}
}
