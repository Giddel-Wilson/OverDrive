import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, users } from '$server/db';
import { requireUser } from '$server/auth';
import { verifyPassword } from '$server/auth-server';
import { logAccess } from '$server/access-log';
import { recentFailedLoginCount, LOGIN_RATE_LIMIT } from '$server/rate-limit';
import { hashRecoveryToken } from '$server/recovery';
import { parseBody } from '$server/validate';
import { setRecoveryKeySchema } from '$server/schemas';
import type { RequestHandler } from './$types';

/**
 * Sets (or replaces) the recovery key material for the signed-in account.
 * Replacing it invalidates the old recovery key. Requires the current
 * password: a stolen session alone must not be able to plant an attacker's
 * recovery key on the account.
 */
export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const sessionUser = requireUser(locals);
	const { currentPassword, recoveryWrappedPrivateKey, recoveryIv, recoveryAuthToken } = parseBody(
		setRecoveryKeySchema,
		await request.json()
	);
	const ip = getClientAddress();

	if ((await recentFailedLoginCount(ip)) >= LOGIN_RATE_LIMIT.maxAttempts) {
		error(429, 'Too many failed attempts. Try again in a few minutes.');
	}

	const [user] = await db.select({ authHash: users.authHash }).from(users).where(eq(users.id, sessionUser.id));
	if (!user) error(404, 'Account not found');

	if (!(await verifyPassword(user.authHash, currentPassword))) {
		await logAccess({ actorId: sessionUser.id, action: 'DECRYPT_ATTEMPT', success: false, failureReason: 'bad_current_password', ipAddress: ip });
		error(401, 'Current password is incorrect');
	}

	await db
		.update(users)
		.set({ recoveryWrappedPrivateKey, recoveryIv, recoveryAuthHash: hashRecoveryToken(recoveryAuthToken) })
		.where(eq(users.id, sessionUser.id));

	return json({ ok: true });
};
