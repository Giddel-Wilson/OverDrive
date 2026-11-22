import { neon } from '@neondatabase/serverless';
import { vaultMigrations } from './vault-migrations.mjs';

try {
	if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
	const sql = neon(process.env.DATABASE_URL);
	const statements = await vaultMigrations();
	const check = `SELECT count(*)::int AS total,
		count(*) FILTER (WHERE upload_status = 'complete' AND deleted_at IS NULL)::int AS active,
		md5(COALESCE(string_agg(id::text || storage_key || wrapped_file_key || file_iv || ciphertext_sha256, '' ORDER BY id), '')) AS integrity
		FROM public.encrypted_files`;
	const results = await sql.transaction([sql(check), ...statements.map((statement) => sql(statement)), sql(check)]);
	const before = results[0][0];
	const after = results.at(-1)[0];
	console.log(JSON.stringify({ migrated: true, additive: true, filesBefore: before.total, filesAfter: after.total, activeFiles: after.active, existingFileKeysPreserved: before.integrity === after.integrity }, null, 2));
} catch (error) {
	console.error(error instanceof Error && !/postgres(?:ql)?:\/\//i.test(error.message) ? error.message : 'Database migration failed. Check Neon connectivity.');
	process.exitCode = 1;
}
