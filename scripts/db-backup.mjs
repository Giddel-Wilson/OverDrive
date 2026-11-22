import { neon } from '@neondatabase/serverless';
import { mkdir, writeFile, readFile, readdir, unlink, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureDatabase, storeVerifiedBackup } from '../src/lib/server/backup-core.ts';
import { backupStorage, requiredEnv } from './backup-storage.mjs';

// An independent key is saved in the ignored local .env before the first backup.
// It is never printed, included in a backup, or derived from the login/session secret.
async function encryptionKey() {
	if (process.env.BACKUP_ENCRYPTION_KEY) return process.env.BACKUP_ENCRYPTION_KEY;
	const path = join(process.cwd(), '.env');
	const contents = await readFile(path, 'utf8');
	const key = randomBytes(32).toString('base64');
	await writeFile(path, `${contents.trimEnd()}\n\n# Database backup encryption key. Keep an offline copy for disaster recovery.\nBACKUP_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
	process.env.BACKUP_ENCRYPTION_KEY = key;
	return key;
}

try {
	const encodedKey = await encryptionKey();
	const sql = neon(requiredEnv('DATABASE_URL'));
	const snapshot = await captureDatabase({
		query: (statement) => sql(statement),
		transaction: (statements) => sql.transaction(statements.map((statement) => sql(statement)), { isolationLevel: 'RepeatableRead', readOnly: true })
	});
	const store = backupStorage();
	const requestedRetention = Number(process.env.BACKUP_RETENTION_DAYS);
	const retention = Number.isInteger(requestedRetention) && requestedRetention >= 1 && requestedRetention <= 3650 ? requestedRetention : 30;
	const result = await storeVerifiedBackup(snapshot, encodedKey, store, retention);
	const archive = await store.get(result.key);
	if (!archive) throw new Error('Verified backup could not be downloaded');
	const directory = join(process.cwd(), '.backups');
	await mkdir(directory, { recursive: true });
	if ((await lstat(directory)).isSymbolicLink()) throw new Error('The local backup directory must not be a symbolic link');
	await writeFile(join(directory, result.key.slice(result.key.lastIndexOf('/') + 1)), new Uint8Array(archive), { mode: 0o600 });
	await writeFile(join(directory, 'latest.json'), JSON.stringify(result, null, 2));
	const cutoff = new Date(snapshot.createdAt).getTime() - retention * 86_400_000;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{12}\.json\.gz\.enc$/.test(entry.name)) continue;
		const createdAt = entry.name.slice(0, 24).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
		const archivePath = resolve(directory, entry.name);
		if (!archivePath.startsWith(resolve(directory) + sep)) throw new Error('Invalid local backup path');
		if (new Date(createdAt).getTime() < cutoff) await unlink(archivePath);
	}
	let statusRecorded = false;
	if (snapshot.catalog.tables.some((table) => table.schema === 'public' && table.name === 'maintenance_state')) {
		await sql('INSERT INTO public.maintenance_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', ['database_backup_success', JSON.stringify(result)]);
		await sql("DELETE FROM public.maintenance_state WHERE key = 'database_backup_failure'");
		statusRecorded = true;
	}
	console.log(JSON.stringify({ ...result, localCopy: '.backups/', verified: true, statusRecorded }, null, 2));
} catch (error) {
	// Provider errors can contain the connection URL; don't print their raw payloads.
	console.error(error instanceof Error && !/postgres(?:ql)?:\/\//i.test(error.message) ? error.message : 'Database backup failed. Check database and B2 connectivity.');
	process.exitCode = 1;
}
