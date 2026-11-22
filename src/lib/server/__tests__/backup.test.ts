import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { captureDatabase, encryptSnapshot, decryptSnapshot, restoreStatements, storeVerifiedBackup, BACKUP_PREFIX, type BackupStorage, type SnapshotConnection } from '../backup-core';
import legacy from '../../shared/__tests__/fixtures/pre-rebrand.json';

function connection(pg: PGlite): SnapshotConnection {
	return {
		query: async (statement) => (await pg.query<Record<string, unknown>>(statement)).rows,
		transaction: (statements) => pg.transaction(async (tx) => {
			await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
			const rows = [];
			for (const statement of statements) rows.push((await tx.query<Record<string, unknown>>(statement)).rows);
			return rows;
		})
	};
}

async function fixture() {
	const pg = new PGlite();
	await pg.exec(`
		CREATE TYPE public.test_algo AS ENUM ('AES-GCM', 'ChaCha20-Poly1305');
		CREATE TABLE public.parents (id bigint PRIMARY KEY, note text NOT NULL, algo public.test_algo NOT NULL, child_id bigint);
		CREATE TABLE public.children (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id bigint REFERENCES public.parents(id), data jsonb, bytes bytea);
		ALTER TABLE public.parents ADD CONSTRAINT cyclic_fk FOREIGN KEY (child_id) REFERENCES public.children(id);
		CREATE INDEX parents_note_idx ON public.parents(note);
		INSERT INTO public.parents VALUES (9007199254740993, 'quotes '' ; \\ and unicode: 日本語', 'AES-GCM', NULL);
		INSERT INTO public.children (parent_id, data, bytes) VALUES (9007199254740993, '{"key":"encrypted","large":9007199254740995}', '\\x010203');
		UPDATE public.parents SET child_id = 1;
	`);
	return pg;
}

describe('database backups', () => {
	it('authenticates and restores a pre-rebrand archive without rounding existing data', async () => {
		const pg = new PGlite();
		try {
			const archive = Buffer.from(legacy.backup, 'base64');
			const snapshot = decryptSnapshot(archive, legacy.backupKey);
			await pg.transaction(async (tx) => {
				for (const statement of restoreStatements(snapshot)) await tx.query(statement);
			});
			expect((await pg.query('SELECT id::text, note FROM public.legacy_files')).rows)
				.toEqual([{ id: '9007199254740993', note: 'legacy ciphertext metadata' }]);
			// Relabeling an archive must not bypass authentication of its old AAD.
			const relabeled = Buffer.concat([Buffer.from('OVERDRIVE-DB-BACKUP-1\n'), archive.subarray(archive.indexOf(10) + 1)]);
			expect(() => decryptSnapshot(relabeled, legacy.backupKey)).toThrow();
			archive[archive.length - 20] ^= 1;
			expect(() => decryptSnapshot(archive, legacy.backupKey)).toThrow();
		} finally { await pg.close(); }
	}, 60_000);

	it('restores schema, cyclic foreign keys, enum values, sequences and exact bigint/JSON values', async () => {
		const pg = await fixture();
		const restored = new PGlite();
		try {
			const snapshot = await captureDatabase(connection(pg));
			const key = randomBytes(32).toString('base64');
			const archive = encryptSnapshot(snapshot, key);
			expect(snapshot.format).toBe('overdrive-database');
			expect(archive.subarray(0, 'OVERDRIVE-DB-BACKUP-1\n'.length).toString()).toBe('OVERDRIVE-DB-BACKUP-1\n');
			expect(archive.toString('utf8')).not.toContain('encrypted');
			const verified = decryptSnapshot(archive, key);
			await restored.transaction(async (tx) => {
				for (const statement of restoreStatements(verified)) await tx.query(statement);
			});
			expect((await restored.query<{ id: string; child: string }>('SELECT id::text, child_id::text AS child FROM public.parents')).rows).toEqual([{ id: '9007199254740993', child: '1' }]);
			expect((await restored.query<{ large: string }>("SELECT data->>'large' AS large FROM public.children")).rows[0].large).toBe('9007199254740995');
			expect((await restored.query<{ id: string }>('INSERT INTO public.children (parent_id) VALUES (9007199254740993) RETURNING id::text')).rows[0].id).toBe('2');
			await expect(restored.query('INSERT INTO public.children (parent_id) VALUES (42)')).rejects.toThrow();
		} finally { await pg.close(); await restored.close(); }
	}, 60_000);

	it('refuses a corrupt archive or a different encryption key', async () => {
		const pg = await fixture();
		try {
			const snapshot = await captureDatabase(connection(pg));
			const key = randomBytes(32).toString('base64');
			const archive = encryptSnapshot(snapshot, key);
			expect(() => decryptSnapshot(archive, randomBytes(32).toString('base64'))).toThrow();
			archive[archive.length - 20] ^= 1;
			expect(() => decryptSnapshot(archive, key)).toThrow();
		} finally { await pg.close(); }
	}, 60_000);

	it('keeps previous snapshots when verification fails, then prunes only backup objects after a verified write', async () => {
		const pg = await fixture();
		try {
			const snapshot = await captureDatabase(connection(pg));
			const key = randomBytes(32).toString('base64');
			const objects = new Map<string, ArrayBuffer>([[`${BACKUP_PREFIX}old.json.gz.enc`, new ArrayBuffer(1)], ['user/file/chunk-0', new ArrayBuffer(1)]]);
			let corrupt = true;
			let listed = 0;
			const store: BackupStorage = {
				set: async (k, b) => { objects.set(k, b); },
				get: async (k) => corrupt ? new ArrayBuffer(10) : objects.get(k) ?? null,
				listPage: async (prefix) => {
					listed++;
					return { objects: [...objects].filter(([k]) => k.startsWith(prefix)).map(([k, b]) => ({ key: k, size: b.byteLength, lastModified: k.endsWith('old.json.gz.enc') ? new Date(0) : new Date() })) };
				},
				deleteMany: async (keys) => { keys.forEach((k) => objects.delete(k)); return { failed: [] }; }
			};
			await expect(storeVerifiedBackup(snapshot, key, store)).rejects.toThrow('verification failed');
			expect(listed).toBe(0);
			expect(objects.has(`${BACKUP_PREFIX}old.json.gz.enc`)).toBe(true);
			corrupt = false;
			const result = await storeVerifiedBackup(snapshot, key, store);
			expect(result.pruned).toBe(1);
			expect(objects.has(result.key)).toBe(true);
			expect(objects.has('user/file/chunk-0')).toBe(true);
		} finally { await pg.close(); }
	}, 60_000);
});
