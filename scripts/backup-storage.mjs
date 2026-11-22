import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

/** @param {string} name */
export function requiredEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export function backupStorage() {
	const Bucket = process.env.B2_BACKUP_BUCKET_NAME || requiredEnv('B2_BUCKET_NAME');
	const client = new S3Client({
		endpoint: requiredEnv('B2_ENDPOINT'), region: requiredEnv('B2_REGION'),
		credentials: { accessKeyId: requiredEnv('B2_KEY_ID'), secretAccessKey: requiredEnv('B2_APPLICATION_KEY') },
		requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED'
	});
	return {
		/** @param {string} key @param {ArrayBuffer} bytes */
		async set(key, bytes) { await client.send(new PutObjectCommand({ Bucket, Key: key, Body: new Uint8Array(bytes) })); },
		/** @param {string} key */
		async get(key) {
			const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
			if (!result.Body) return null;
			return Uint8Array.from(await result.Body.transformToByteArray()).buffer;
		},
		/** @param {string} prefix @param {string} [token] @param {number} [maxKeys] */
		async listPage(prefix, token, maxKeys = 1000) {
			const result = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: maxKeys }));
			return {
				objects: (result.Contents ?? []).filter((o) => o.Key).map((o) => ({ key: /** @type {string} */ (o.Key), size: o.Size ?? 0, lastModified: o.LastModified })),
				next: result.IsTruncated ? result.NextContinuationToken : undefined
			};
		},
		/** @param {string[]} keys */
		async deleteMany(keys) {
			/** @type {string[]} */ const failed = [];
			for (let i = 0; i < keys.length; i += 1000) {
				try {
					const result = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
					for (const error of result.Errors ?? []) if (error.Key) failed.push(error.Key);
				} catch { failed.push(...keys.slice(i, i + 1000)); }
			}
			return { failed };
		}
	};
}
