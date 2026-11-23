import { readFile } from 'node:fs/promises';

/** Schema upgrades shared by deployment and recovery of older snapshots. */
export async function vaultMigrations() {
	const names = ['0001_gallery_versions.sql', '0002_session_devices.sql', '0003_share_limit_revocation.sql', '0004_remove_signup_invites.sql'];
	const contents = await Promise.all(names.map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8')));
	return contents.flatMap((migration) => migration.split(';').map((statement) => statement.trim()).filter(Boolean));
}
