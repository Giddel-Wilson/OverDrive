import { readFile, writeFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { BACKUP_PREFIX, decryptSnapshot, DISCOVER_TABLES_SQL, restoreStatements } from '../src/lib/server/backup-core.ts';
import { backupStorage, requiredEnv } from './backup-storage.mjs';
import { vaultMigrations } from './vault-migrations.mjs';

/** @param {string} name */
const option = (name) => {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
};

try {
	const file = option('--file');
	const key = option('--from');
	if (!file && (!key || !key.startsWith(BACKUP_PREFIX))) throw new Error('Supply --file <encrypted local archive> or --from <B2 backup object key>');
	const archive = file ? await readFile(file) : await backupStorage().get(/** @type {string} */ (key));
	if (!archive) throw new Error('Backup not found');
	const snapshot = decryptSnapshot(new Uint8Array(archive), requiredEnv('BACKUP_ENCRYPTION_KEY'));
	const statements = restoreStatements(snapshot);
	const sqlOutput = option('--sql-out');
	if (sqlOutput) {
		await writeFile(sqlOutput, `-- Vault database snapshot ${snapshot.createdAt}\nBEGIN;\n${statements.join(';\n')};\nCOMMIT;\n`, { mode: 0o600 });
		console.log('Decrypted SQL written to the requested file.');
	} else {
		// Never default to DATABASE_URL or allow an overwrite. Recovery happens in a
		// new, empty database, which can be verified before changing the app URL.
		const targetUrl = requiredEnv('DATABASE_RESTORE_URL');
		if (process.env.DATABASE_URL) {
			const source = new URL(process.env.DATABASE_URL);
			const target = new URL(targetUrl);
			const host = (url) => url.hostname.replace('-pooler.', '.');
			if (host(source) === host(target) && source.pathname === target.pathname) throw new Error('The restore target must be a different database from DATABASE_URL');
		}
		const target = neon(targetUrl);
		if ((await target(DISCOVER_TABLES_SQL)).length) throw new Error('The restore target is not empty. Create a fresh database first.');
		// Older backups must work with the current application's columns too.
		statements.push(...await vaultMigrations());
		// Restoring an old snapshot must not resurrect sessions that were revoked later.
		if (snapshot.catalog.tables.some((t) => t.schema === 'public' && t.name === 'sessions')) statements.push('UPDATE public.sessions SET revoked_at = now()');
		await target.transaction(statements.map((statement) => target(statement)), { isolationLevel: 'Serializable' });
		console.log(JSON.stringify({ restored: true, createdAt: snapshot.createdAt, tables: snapshot.tables.length, sessionsRevoked: true }, null, 2));
	}
} catch (error) {
	console.error(error instanceof Error && !/postgres(?:ql)?:\/\//i.test(error.message) ? error.message : 'Database restore failed. Check the target database connection.');
	process.exitCode = 1;
}
