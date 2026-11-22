import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, users } from '$server/db';
import { hashPassword } from '$server/auth-server';
import { logAccess } from '$server/access-log';
import { revokeSessions } from '$server/sessions';
import { recentFailedLoginCount, LOGIN_RATE_LIMIT } from '$server/rate-limit';
import { decoyRecoveryBlob, recoveryTokenMatches } from '$server/recovery';
import { parseBody } from '$server/validate';
import { recoverSchema } from '$server/schemas';
import type { RequestHandler } from './$types';

const emailQuery = z.string().trim().toLowerCase().email().max(320);

/**
 * Step 1 of recovery: hand back the recovery-wrapped private key for an
 * email so the browser can try to open it with the recovery key the user
 * typed. Unknown emails (and accounts with no recovery key) get a
 * deterministic decoy of the same shape, so this endpoint can't be used to
 * discover who has an account. The blob is useless without the 256-bit
 * recovery key, so serving it unauthenticated is safe.
 */
export const GET: RequestHandler = async ({ url }) => {
	const parsed = emailQuery.safeParse(url.searchParams.get('email'));
	if (!parsed.success) error(400, 'A valid email is required');
	const email = parsed.data;

	const [user] = await db
		.select({
			keyAlgo: users.keyAlgo,
			recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
			recoveryIv: users.recoveryIv
		})
		.from(users)
		.where(eq(users.email, email));

	if (user?.recoveryWrappedPrivateKey && user.recoveryIv) {
		return json({
			keyAlgo: user.keyAlgo,
			recoveryWrappedPrivateKey: user.recoveryWrappedPrivateKey,
			recoveryIv: user.recoveryIv
		});
	}
	return json(decoyRecoveryBlob(email));
};

/**
 * Step 2: the browser opened the recovery blob, re-wrapped the SAME private
 * key under a new password, and proves possession of the recovery key with
 * a derived token. On success the login password, the password-wrapped
 * key copy and (for safety) 2FA are replaced. The private key itself is
 * unchanged, so every file stays decryptable and the recovery key stays
 * valid.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const body = parseBody(recoverSchema, await request.json());
	const ip = getClientAddress();

	if ((await recentFailedLoginCount(ip)) >= LOGIN_RATE_LIMIT.maxAttempts) {
		error(429, 'Too many failed attempts. Try again in a few minutes.');
	}

	const [user] = await db.select().from(users).where(eq(users.email, body.email));
	if (!user || !user.recoveryAuthHash || !recoveryTokenMatches(user.recoveryAuthHash, body.recoveryAuthToken)) {
		await logAccess({
			actorId: user?.id ?? null,
			action: 'DECRYPT_ATTEMPT',
			success: false,
			failureReason: 'bad_recovery_key',
			ipAddress: ip
		});
		error(401, 'That recovery key does not match this account');
	}

	await db
		.update(users)
		.set({
			authHash: await hashPassword(body.newPassword),
			wrappedPrivateKey: body.wrappedPrivateKey,
			wrappedPrivateKeyIv: body.wrappedPrivateKeyIv,
			privateKeyKdf: body.privateKeyKdf,
			privateKeyKdfParams: body.privateKeyKdfParams,
			totpEnabled: false,
			totpSecretEnc: null,
			totpLastStep: null
		})
		.where(eq(users.id, user.id));

	// Recovery means the old password may be compromised: end every session.
	await revokeSessions(user.id);

	await logAccess({ actorId: user.id, action: 'DECRYPT_ATTEMPT', success: true, failureReason: 'account_recovered', ipAddress: ip });
	return json({ ok: true });
};
