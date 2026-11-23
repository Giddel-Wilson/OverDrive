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
	const checkAccounts = `SELECT count(*)::int AS total,
		md5(COALESCE(string_agg((to_jsonb(account) - 'invite_id')::text, '' ORDER BY id), '')) AS integrity FROM public.users account`;
	const checkRetiredData = `SELECT to_regclass('public.invites') IS NULL AND NOT EXISTS (
		SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'invite_id'
	) AS removed`;
	const results = await sql.transaction([
		sql(check), sql(checkAccounts), ...statements.map((statement) => sql(statement)), sql(check), sql(checkAccounts), sql(checkRetiredData)
	], { isolationLevel: 'RepeatableRead' });
	const before = results[0][0];
	const accountsBefore = results[1][0];
	const after = results.at(-3)[0];
	const accountsAfter = results.at(-2)[0];
	const existingFileKeysPreserved = before.integrity === after.integrity && before.total === after.total;
	const existingAccountKeysPreserved = accountsBefore.integrity === accountsAfter.integrity && accountsBefore.total === accountsAfter.total;
	const retiredSignupDataRemoved = results.at(-1)[0].removed;
	console.log(JSON.stringify({ migrated: true, filesBefore: before.total, filesAfter: after.total, activeFiles: after.active,
		accountsBefore: accountsBefore.total, accountsAfter: accountsAfter.total, existingFileKeysPreserved, existingAccountKeysPreserved, retiredSignupDataRemoved }, null, 2));
	if (!existingFileKeysPreserved || !existingAccountKeysPreserved || !retiredSignupDataRemoved) throw new Error('The schema migration did not pass preservation verification');
} catch (error) {
	console.error(error instanceof Error && !/postgres(?:ql)?:\/\//i.test(error.message) ? error.message : 'Database migration failed. Check Neon connectivity.');
	process.exitCode = 1;
}
