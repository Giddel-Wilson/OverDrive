import { json } from '@sveltejs/kit';
import { requireCron } from '$server/cron';
import { runCleanup } from '$server/cleanup';
import type { RequestHandler } from './$types';

/**
 * Called daily by Vercel Cron (vercel.json). Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` automatically when a CRON_SECRET env
 * var exists on the project; anything else is refused, so the endpoint can't
 * be triggered by the public.
 */
export const GET: RequestHandler = async ({ request }) => {
	requireCron(request);

	return json(await runCleanup());
};
