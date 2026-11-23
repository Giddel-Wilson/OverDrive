import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

describe('public signup schema upgrade', () => {
	it('removes retired signup data while preserving accounts, quotas and encrypted file keys', async () => {
		const pg = new PGlite();
		try {
			await pg.exec(`
				CREATE TABLE public.users (id uuid PRIMARY KEY, invite_id uuid, auth_hash text NOT NULL, wrapped_private_key text NOT NULL, storage_quota_bytes bigint);
				CREATE TABLE public.invites (id uuid PRIMARY KEY, created_by uuid REFERENCES public.users(id));
				CREATE TABLE public.encrypted_files (id uuid PRIMARY KEY, owner_id uuid REFERENCES public.users(id), storage_key text, wrapped_file_key text, file_iv text);
				INSERT INTO public.users VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'auth-verifier', 'wrapped-private-key', 1073741824);
				INSERT INTO public.invites VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
				INSERT INTO public.encrypted_files VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'original-storage', 'wrapped-file-key', 'original-nonce');
			`);
			const userQuery = 'SELECT id, auth_hash, wrapped_private_key, storage_quota_bytes FROM public.users';
			const users = (await pg.query(userQuery)).rows;
			const files = (await pg.query('SELECT * FROM public.encrypted_files')).rows;
			const migration = await readFile(new URL('../../../../drizzle/0004_remove_signup_invites.sql', import.meta.url), 'utf8');
			await pg.exec(migration);
			await pg.exec(migration);
			expect((await pg.query(userQuery)).rows).toEqual(users);
			expect((await pg.query('SELECT * FROM public.encrypted_files')).rows).toEqual(files);
			expect((await pg.query("SELECT to_regclass('public.invites') IS NULL AS removed")).rows).toEqual([{ removed: true }]);
			expect((await pg.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'invite_id'")).rows).toEqual([]);
		} finally { await pg.close(); }
	}, 60_000);
});
