import { json } from '@sveltejs/kit';
import { requireCron } from '$server/cron';
import { runDatabaseBackup } from '$server/backup';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireCron(request);
	return json(await runDatabaseBackup(), { headers: { 'Cache-Control': 'no-store' } });
};
