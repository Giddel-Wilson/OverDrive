import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	NotFound
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '$env/dynamic/private';
import { PRESIGN_EXPIRES_SECONDS } from '$lib/shared/limits';

/** SHA-256 hex digest, server-side. WebCrypto is available globally in the Node 20 runtime. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function requireEnv(name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is not set — required for blob storage`);
	return value;
}

let cachedClient: S3Client | null = null;

function s3Client(): S3Client {
	if (cachedClient) return cachedClient;
	cachedClient = new S3Client({
		region: env.B2_REGION || 'us-west-004', // Backblaze doesn't use AWS regions, but the SDK requires a value — must match your bucket's actual region
		endpoint: requireEnv('B2_ENDPOINT'), // e.g. https://s3.us-west-004.backblazeb2.com
		credentials: {
			accessKeyId: requireEnv('B2_KEY_ID'),
			secretAccessKey: requireEnv('B2_APPLICATION_KEY')
		},
		// Newer SDK versions add a CRC32 checksum header/query param to every
		// PutObject by default. Backblaze B2 rejects (or mis-validates) those,
		// and for presigned URLs the browser would have to reproduce the
		// checksum of a body it hasn't produced yet. Only send checksums when
		// an operation actually requires one.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
	return cachedClient;
}

export interface StoredObject {
	key: string;
	size: number;
}

/**
 * Thin wrapper over the B2 (S3-compatible) bucket. Same set/get/delete
 * shape the routes already used, plus list / deleteMany for upload
 * verification and permanent deletion, and presignPut so the browser can
 * upload ciphertext chunks straight to the bucket.
 */
export function filesStore() {
	const client = s3Client();
	const Bucket = requireEnv('B2_BUCKET_NAME');

	return {
		async set(key: string, data: ArrayBuffer): Promise<void> {
			await client.send(new PutObjectCommand({ Bucket, Key: key, Body: new Uint8Array(data) }));
		},

		async get(key: string, _opts?: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null> {
			try {
				const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
				if (!res.Body) return null;
				const bytes = await res.Body.transformToByteArray();
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			} catch (err) {
				if (err instanceof NotFound) return null;
				// The S3 SDK sometimes surfaces a missing key as a generic error
				// with a 404 status rather than throwing NotFound directly,
				// depending on the provider — Backblaze's S3-compatible API
				// included. Treat either shape as "not found".
				if (
					typeof err === 'object' &&
					err !== null &&
					'$metadata' in err &&
					(err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
				) {
					return null;
				}
				throw err;
			}
		},

		async delete(key: string): Promise<void> {
			await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
		},

		/** Deletes many keys (1000 per request, the S3 limit). Failures are reported, not thrown. */
		async deleteMany(keys: string[]): Promise<{ failed: string[] }> {
			const failed: string[] = [];
			for (let i = 0; i < keys.length; i += 1000) {
				const batch = keys.slice(i, i + 1000);
				try {
					const res = await client.send(
						new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } })
					);
					for (const e of res.Errors ?? []) if (e.Key) failed.push(e.Key);
				} catch {
					failed.push(...batch);
				}
			}
			return { failed };
		},

		/** Lists every object under a prefix (follows pagination). */
		async list(prefix: string): Promise<StoredObject[]> {
			const out: StoredObject[] = [];
			let ContinuationToken: string | undefined;
			do {
				const res = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
				for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
				ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
			} while (ContinuationToken);
			return out;
		},

		/** A time-limited URL the browser can PUT one ciphertext chunk to directly. */
		async presignPut(key: string, expiresIn = PRESIGN_EXPIRES_SECONDS): Promise<string> {
			return getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key }), { expiresIn });
		}
	};
}

/** Object-key helpers shared by every route that touches chunk storage. */
export const chunkPrefix = (ownerId: string, fileId: string) => `${ownerId}/${fileId}/`;
export const chunkKey = (ownerId: string, fileId: string, index: number) =>
	`${chunkPrefix(ownerId, fileId)}chunk-${index}`;
