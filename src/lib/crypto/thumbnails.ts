import { decryptBlob, encryptBlob, createSha256Stream } from './file-encryption';
import { fromBase64, toBase64 } from './encoding';
import { createBlobSink, decryptFileToSink, decryptRecordMetadata, unwrapRecordFileKey, type EncryptedFileRecord } from './download-pipeline';
import { MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_SOURCE_BYTES, THUMBNAIL_EDGE } from '../shared/limits';
import { THUMBNAIL_INFO_V1 } from '../shared/legacy-protocol.js';
import heicWasmUrl from '@discourse/heic/codec/dec/heic_dec.wasm?url';
import jxlWasmUrl from '@jsquash/jxl/codec/dec/jxl_dec.wasm?url';
import avifWasmUrl from '@jsquash/avif/codec/dec/avif_dec.wasm?url';

export interface EncryptedThumbnail { encryptedBlob: string; iv: string; ciphertextSha256: string }

// Let the browser's image decoder decide which image subtypes it can rasterize.
// A fixed list silently excluded valid types such as SVG, TIFF, and newer formats.
const safeImage = /^image\/[a-z0-9.+-]+$/i;
const thumbnailMime = new Set(['image/webp', 'image/jpeg', 'image/png']);
const heicMimes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
type ImageDataDecoder = (data: ArrayBuffer) => Promise<ImageData | null>;
let heicDecoder: Promise<ImageDataDecoder> | undefined;
let jxlDecoder: Promise<ImageDataDecoder> | undefined;
let avifDecoder: Promise<ImageDataDecoder> | undefined;

async function decodeWithCodec(source: Blob, mime: string): Promise<ImageData | null> {
	const data = await source.arrayBuffer();
	if (heicMimes.has(mime)) {
		heicDecoder ??= (async () => {
			const codec = await import('@discourse/heic/decode');
			await codec.init({ locateFile: () => heicWasmUrl });
			return codec.default;
		})();
		return (await heicDecoder)(data);
	}
	if (mime === 'image/jxl') {
		jxlDecoder ??= (async () => {
			const codec = await import('@jsquash/jxl/decode');
			await codec.init({ locateFile: () => jxlWasmUrl });
			return codec.default;
		})();
		return (await jxlDecoder)(data);
	}
	if (mime === 'image/avif') {
		avifDecoder ??= (async () => {
			const codec = await import('@jsquash/avif/decode');
			await codec.init({ locateFile: () => avifWasmUrl });
			return codec.default;
		})();
		return (await avifDecoder)(data);
	}
	if (mime === 'image/tiff' || mime === 'image/tif') {
		const UTIF = await import('utif');
		const ifds = UTIF.decode(data);
		const first = ifds[0];
		if (!first) return null;
		UTIF.decodeImage(data, first);
		const rgba = UTIF.toRGBA8(first);
		return new ImageData(new Uint8ClampedArray(rgba), first.width, first.height);
	}
	return null;
}

async function thumbnailKey(fileKey: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', Uint8Array.from(fileKey).buffer, 'HKDF', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: new TextEncoder().encode(THUMBNAIL_INFO_V1) }, key, 256));
}

/** Rasterize locally. Unsupported formats and oversized sources keep a placeholder. */
export async function createPhotoThumbnail(source: Blob): Promise<Blob | null> {
	const mime = source.type.split(';', 1)[0].trim().toLowerCase();
	if (!safeImage.test(mime) || source.size > MAX_THUMBNAIL_SOURCE_BYTES || typeof document === 'undefined') return null;
	let image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null = null;
	let sourceUrl: string | null = null;
	try {
		if (typeof createImageBitmap === 'function') {
			try {
				image = await createImageBitmap(source, { imageOrientation: 'from-image' });
			} catch {
				// Some browsers expose createImageBitmap but lack a decoder for a
				// particular image subtype. Continue through the format fallbacks.
			}
		}
		if (!image) {
			try {
				const decoded = await decodeWithCodec(source, mime);
				if (decoded) {
					const decodedCanvas = document.createElement('canvas');
					decodedCanvas.width = decoded.width;
					decodedCanvas.height = decoded.height;
					const decodedContext = decodedCanvas.getContext('2d');
					if (!decodedContext) return null;
					decodedContext.putImageData(decoded, 0, 0);
					image = typeof createImageBitmap === 'function' ? await createImageBitmap(decodedCanvas) : decodedCanvas;
				}
			} catch {
				// If a codec cannot parse this particular file, try the browser's
				// regular image element below before giving up.
			}
		}
		if (!image) {
			sourceUrl = URL.createObjectURL(source);
			const element = new Image();
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Image decoding timed out')), 15_000);
				element.onload = () => { clearTimeout(timeout); resolve(); };
				element.onerror = () => { clearTimeout(timeout); reject(new Error('This image format cannot be decoded')); };
				element.src = sourceUrl!;
			});
			image = element;
		}
		const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
		const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
		if (!width || !height || width * height > 80_000_000) return null;
		const ratio = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(width * ratio));
		canvas.height = Math.max(1, Math.round(height * ratio));
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
		return blob && thumbnailMime.has(blob.type) && blob.size + 64 <= MAX_THUMBNAIL_BYTES ? blob : null;
	} catch { return null; }
	finally {
		if (image && 'close' in image) image.close();
		if (sourceUrl) URL.revokeObjectURL(sourceUrl);
	}
}

/** A separate HKDF key and random nonce prevent reuse of content-encryption nonces. */
export async function encryptPhotoThumbnail(image: Blob, fileKey: Uint8Array): Promise<EncryptedThumbnail> {
	if (!thumbnailMime.has(image.type)) throw new Error('Unsupported thumbnail format');
	const mime = new TextEncoder().encode(image.type);
	const bytes = new Uint8Array(await image.arrayBuffer());
	const plaintext = new Uint8Array(1 + mime.length + bytes.length);
	plaintext[0] = mime.length;
	plaintext.set(mime, 1);
	plaintext.set(bytes, 1 + mime.length);
	if (plaintext.length + 16 > MAX_THUMBNAIL_BYTES) throw new Error('Thumbnail is too large');
	const encrypted = await encryptBlob(plaintext, await thumbnailKey(fileKey), 'AES-GCM');
	const hash = await createSha256Stream();
	hash.update(encrypted.ciphertext);
	return { encryptedBlob: toBase64(encrypted.ciphertext), iv: toBase64(encrypted.iv), ciphertextSha256: hash.digestHex() };
}

export async function decryptPhotoThumbnail(ciphertext: Uint8Array, manifest: NonNullable<EncryptedFileRecord['thumbnail']>, fileKey: Uint8Array): Promise<Blob> {
	if (ciphertext.length !== manifest.sizeBytes || ciphertext.length > MAX_THUMBNAIL_BYTES) throw new Error('Thumbnail size does not match');
	const hash = await createSha256Stream();
	hash.update(ciphertext);
	if (hash.digestHex() !== manifest.ciphertextSha256) throw new Error('Thumbnail integrity check failed');
	const plaintext = await decryptBlob(ciphertext, await thumbnailKey(fileKey), 'AES-GCM', fromBase64(manifest.iv));
	const mimeLength = plaintext[0];
	const mime = new TextDecoder().decode(plaintext.subarray(1, 1 + mimeLength));
	if (!thumbnailMime.has(mime) || plaintext.length <= 1 + mimeLength) throw new Error('Invalid thumbnail image');
	return new Blob([Uint8Array.from(plaintext.subarray(1 + mimeLength)).buffer], { type: mime });
}

// A gallery can mount hundreds of tiles; only four fetch/decrypt operations run at once.
let active = 0;
const waiters: (() => void)[] = [];
async function acquire() {
	if (active < 4) { active++; return; }
	await new Promise<void>((resolve) => waiters.push(resolve));
}
function release() {
	const next = waiters.shift();
	if (next) next(); else active--;
}

export async function fetchPhotoThumbnail(record: EncryptedFileRecord, privateKey: CryptoKey, signal: AbortSignal): Promise<Blob> {
	if (!record.thumbnail) throw new Error('No thumbnail');
	await acquire();
	try {
		signal.throwIfAborted();
		const result = await fetch(`/api/files/${record.id}/thumbnail?revision=${record.versionNumber ?? 1}`, { signal, cache: 'no-store' });
		if (!result.ok) throw new Error('Thumbnail unavailable');
		const fileKey = await unwrapRecordFileKey(record, privateKey);
		return await decryptPhotoThumbnail(new Uint8Array(await result.arrayBuffer()), record.thumbnail, fileKey);
	} finally { release(); }
}

/** Explicit one-time backfill: fetch/decrypt the original locally, then upload only the encrypted derivative. */
export async function backfillPhotoThumbnail(record: EncryptedFileRecord, privateKey: CryptoKey): Promise<boolean> {
	if (record.thumbnail) return false;
	const fileKey = await unwrapRecordFileKey(record, privateKey);
	const metadata = await decryptRecordMetadata(record, fileKey);
	if (!metadata || !safeImage.test(metadata.mimeType) || metadata.size > MAX_THUMBNAIL_SOURCE_BYTES) return false;
	const { sink, toBlob } = createBlobSink(metadata.mimeType);
	await decryptFileToSink(record, fileKey, sink);
	const image = await createPhotoThumbnail(toBlob());
	if (!image) return false;
	const thumbnail = await encryptPhotoThumbnail(image, fileKey);
	const response = await fetch(`/api/files/${record.id}/thumbnail`, {
		method: 'PUT', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ versionNumber: record.versionNumber ?? 1, thumbnail })
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(body.message ?? 'Could not save thumbnail');
	}
	return true;
}
