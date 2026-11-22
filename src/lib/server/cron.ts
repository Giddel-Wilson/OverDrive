import { error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

export function requireCron(request: Request) {
	const secret = env.CRON_SECRET;
	if (!secret || secret.length < 16) error(503, 'CRON_SECRET is not configured (set a random 16+ character value)');
	const given = Buffer.from(request.headers.get('authorization') ?? '');
	const expected = Buffer.from(`Bearer ${secret}`);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) error(401, 'Unauthorized');
}
