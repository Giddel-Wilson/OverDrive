import { json } from '@sveltejs/kit';
import { requireUser } from '$server/auth';
import { getUsage } from '$server/quota';
import type { RequestHandler } from './$types';

/** Storage used vs. the user's limit (quotaBytes 0 = unlimited). */
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json(await getUsage(user.id));
};
