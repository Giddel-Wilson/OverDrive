// Configures CORS on your Backblaze B2 bucket so browsers may PUT ciphertext
// chunks straight to it through presigned URLs (uploads) and GET them back.
//
//   npm run b2:cors -- https://your-app.vercel.app http://localhost:5173
//
// Reads B2_ENDPOINT / B2_REGION / B2_KEY_ID / B2_APPLICATION_KEY /
// B2_BUCKET_NAME from .env (via `node --env-file`). The application key needs
// the "writeBuckets" capability to change CORS — if yours is read/write only,
// create a temporary key with that capability, run this once, then delete it.
//
// Backblaze documents PutBucketCors/GetBucketCors on its S3-compatible API:
// https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules

import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const origins = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
const required = ['B2_ENDPOINT', 'B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET_NAME'];
const missing = required.filter((k) => !process.env[k]);

if (missing.length || origins.length === 0) {
	console.error(
		[
			missing.length ? `Missing env vars: ${missing.join(', ')}` : '',
			origins.length === 0 ? 'Give at least one allowed origin, e.g.:' : '',
			origins.length === 0 ? '  npm run b2:cors -- https://your-app.vercel.app http://localhost:5173' : ''
		]
			.filter(Boolean)
			.join('\n')
	);
	process.exit(1);
}

const client = new S3Client({
	region: process.env.B2_REGION || 'us-west-004',
	endpoint: process.env.B2_ENDPOINT,
	credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APPLICATION_KEY },
	requestChecksumCalculation: 'WHEN_REQUIRED',
	responseChecksumValidation: 'WHEN_REQUIRED'
});
const Bucket = process.env.B2_BUCKET_NAME;

const rules = [
	{
		ID: 'endtoend-encrypt-browser-chunks',
		AllowedOrigins: origins,
		AllowedMethods: ['PUT', 'GET', 'HEAD'],
		AllowedHeaders: ['*'],
		ExposeHeaders: ['ETag'],
		MaxAgeSeconds: 3600
	}
];

try {
	await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
	const { CORSRules } = await client.send(new GetBucketCorsCommand({ Bucket }));
	console.log(`CORS set on "${Bucket}". Allowed origins:`);
	for (const r of CORSRules ?? []) console.log(`  ${r.AllowedOrigins?.join(', ')}  [${r.AllowedMethods?.join(', ')}]`);
} catch (err) {
	console.error(`Could not set CORS: ${err?.name ?? 'Error'} — ${err?.message ?? err}`);
	console.error(
		[
			'',
			'If this is an access error, your application key lacks the "writeBuckets" capability.',
			'Alternatives:',
			'  • B2 web UI: Buckets → your bucket → Bucket Settings → CORS Rules (custom rules, S3-compatible operations)',
			'  • B2 CLI:    b2 bucket update --cors-rules "<json>" <bucketName>   (see Backblaze docs)'
		].join('\n')
	);
	process.exit(1);
}
