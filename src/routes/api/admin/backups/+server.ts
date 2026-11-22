import { json } from '@sveltejs/kit';
import { requireAdmin } from '$server/admin';
import { backupStatus, runDatabaseBackup } from '$server/backup';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	return json(await backupStatus(), { headers: { 'Cache-Control': 'no-store' } });
};
export const POST: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	return json(await runDatabaseBackup(), { headers: { 'Cache-Control': 'no-store' } });
};
