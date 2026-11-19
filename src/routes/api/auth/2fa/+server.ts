import { json, error } from '@sveltejs/kit';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db, users } from '$server/db';
import { requireUser } from '$server/auth';
import { verifyPassword } from '$server/auth-server';
import { logAccess } from '$server/access-log';
import { recentFailedLoginCount, LOGIN_RATE_LIMIT } from '$server/rate-limit';
import { parseBody } from '$server/validate';
import { twoFactorSchema } from '$server/schemas';
import { generateTotpSecret, otpauthUri, verifyTotp } from '$server/totp';
import { sealTotpSecret, openTotpSecret } from '$server/two-factor';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const sessionUser = requireUser(locals);
	const [user] = await db.select({ enabled: users.totpEnabled }).from(users).where(eq(users.id, sessionUser.id));
	return json({ enabled: user?.enabled ?? false });
};

/**
 *  {action:'setup'}                    create a secret (not active yet)
 *  {action:'enable',  code}            prove the authenticator works, turn 2FA on
 *  {action:'disable', password, code}  turn it off (needs both factors)
 */
export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const sessionUser = requireUser(locals);
	const body = parseBody(twoFactorSchema, await request.json());
	const ip = getClientAddress();

	const [user] = await db.select().from(users).where(eq(users.id, sessionUser.id));
	if (!user) error(404, 'Account not found');

	if (body.action === 'setup') {
		if (user.totpEnabled) error(409, 'Two-factor authentication is already on');
		const secret = generateTotpSecret();
		await db
			.update(users)
			.set({ totpSecretEnc: sealTotpSecret(secret), totpEnabled: false, totpLastStep: null })
			.where(eq(users.id, user.id));
		return json({ secret, otpauthUri: otpauthUri(secret, user.email) });
	}

	if (body.action === 'enable') {
		if (user.totpEnabled) error(409, 'Two-factor authentication is already on');
		if (!user.totpSecretEnc) error(400, 'Start setup first');
		const step = verifyTotp(openTotpSecret(user.totpSecretEnc), body.code);
		if (step === null) error(400, 'That code is not valid — check your authenticator and try again');
		await db.update(users).set({ totpEnabled: true, totpLastStep: step }).where(eq(users.id, user.id));
		return json({ ok: true });
	}

	// disable — both factors required, and wrong attempts count toward the
	// same lockout as sign-in so this can't be used to brute-force the code.
	if (!user.totpEnabled || !user.totpSecretEnc) error(409, 'Two-factor authentication is not on');
	if ((await recentFailedLoginCount(ip)) >= LOGIN_RATE_LIMIT.maxAttempts) {
		error(429, 'Too many failed attempts. Try again in a few minutes.');
	}

	const passwordOk = await verifyPassword(user.authHash, body.password);
	const step = passwordOk ? verifyTotp(openTotpSecret(user.totpSecretEnc), body.code, { lastUsedStep: user.totpLastStep }) : null;
	if (!passwordOk || step === null) {
		await logAccess({
			actorId: user.id,
			action: 'DECRYPT_ATTEMPT',
			success: false,
			failureReason: passwordOk ? 'bad_totp' : 'bad_password',
			ipAddress: ip
		});
		error(401, 'Password or authentication code is incorrect');
	}

	await db
		.update(users)
		.set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
		.where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))));
	return json({ ok: true });
};
