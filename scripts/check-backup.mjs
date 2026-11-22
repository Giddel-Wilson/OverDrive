import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { decryptSnapshot, restoreStatements, quoteIdentifier } from '../src/lib/server/backup-core.ts';
import { requiredEnv } from './backup-storage.mjs';
import { vaultMigrations } from './vault-migrations.mjs';

const pg = new PGlite();
try {
	const archives = (await readdir('.backups')).filter((name) => name.endsWith('.json.gz.enc')).sort();
	const args = process.argv.slice(2);
	const name = args.find((argument) => !argument.startsWith('--')) || archives.at(-1);
	if (!name) throw new Error('No local backup to verify');
	const snapshot = decryptSnapshot(await readFile(join('.backups', name)), requiredEnv('BACKUP_ENCRYPTION_KEY'));
	await pg.transaction(async (tx) => { for (const statement of restoreStatements(snapshot)) await tx.query(statement); });
	let rows = 0;
	for (const table of snapshot.tables) {
		const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
		const count = await pg.query(`SELECT count(*)::int AS count FROM ONLY ${qualified}`);
		if (count.rows[0].count !== table.rows) throw new Error('Restored row count differs from the backup');
		const differences = await pg.query(`SELECT count(*)::int AS count FROM (
			SELECT row_to_json(actual)::jsonb FROM ONLY ${qualified} actual
			EXCEPT ALL SELECT row_to_json(expected)::jsonb FROM json_populate_recordset(NULL::${qualified}, $1::json) expected
		) differences`, [table.json]);
		if (differences.rows[0].count !== 0) throw new Error('Restored data differs from the backup');
		rows += table.rows;
	}
	const upgraded = args.includes('--upgrade');
	if (upgraded) {
		await pg.transaction(async (tx) => { for (const statement of await vaultMigrations()) await tx.query(statement); });
		await pg.query('SELECT version_number, thumbnail_iv FROM public.encrypted_files LIMIT 1');
		await pg.query('SELECT device_id, token_version FROM public.sessions LIMIT 1');
	}
	console.log(JSON.stringify({ verifiedRestore: true, createdAt: snapshot.createdAt, tables: snapshot.tables.length, rows, upgraded, database: 'temporary in-memory Postgres' }, null, 2));
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Backup restore verification failed');
	process.exitCode = 1;
} finally { await pg.close(); }
