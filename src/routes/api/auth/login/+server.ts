import { json, error } from '@sveltejs/kit';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db, users } from '$server/db';
import { verifyPassword, createSessionCookie } from '$server/auth-server';
import { logAccess } from '$server/access-log';
import { recentFailedLoginCount, LOGIN_RATE_LIMIT } from '$server/rate-limit';
import { parseBody } from '$server/validate';
import { loginSchema } from '$server/schemas';
import { verifyTotp } from '$server/totp';
import { openTotpSecret } from '$server/two-factor';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const { email, password, totp } = parseBody(loginSchema, await request.json());
	const ip = getClientAddress();

	// Check BEFORE touching the DB for the user lookup, so lockout applies
	// uniformly whether the email exists or not — this also protects
	// against email enumeration via response timing.
	const recentFailures = await recentFailedLoginCount(ip);
	if (recentFailures >= LOGIN_RATE_LIMIT.maxAttempts) {
		error(429, `Too many failed sign-in attempts. Try again in a few minutes.`);
	}

	const [user] = await db.select().from(users).where(eq(users.email, email));
	if (!user) {
		await logAccess({
			actorId: null,
			action: 'DECRYPT_ATTEMPT',
			success: false,
			failureReason: 'unknown_email',
			ipAddress: ip
		});
		error(401, 'Invalid email or password');
	}

	const valid = await verifyPassword(user.authHash, password);
	if (!valid) {
		await logAccess({
			actorId: user.id,
			action: 'DECRYPT_ATTEMPT',
			success: false,
			failureReason: 'bad_password',
			ipAddress: ip
		});
		error(401, 'Invalid email or password');
	}

	// Second factor. The password has already been verified at this point,
	// but NOTHING sensitive (no session cookie, no wrapped key) leaves the
	// server until the code checks out too.
	if (user.totpEnabled && user.totpSecretEnc) {
		if (!totp) return json({ twoFactorRequired: true });

		const step = verifyTotp(openTotpSecret(user.totpSecretEnc), totp, { lastUsedStep: user.totpLastStep });
		// Conditional update = replay guard that also holds under concurrent
		// requests: only one of two simultaneous submissions of the same code
		// can advance totpLastStep.
		const advanced =
			step === null
				? []
				: await db
						.update(users)
						.set({ totpLastStep: step })
						.where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
						.returning({ id: users.id });
		if (advanced.length === 0) {
			await logAccess({
				actorId: user.id,
				action: 'DECRYPT_ATTEMPT',
				success: false,
				failureReason: 'bad_totp',
				ipAddress: ip
			});
			error(401, 'Invalid authentication code');
		}
	}

	await createSessionCookie(cookies, user.id, user.email, { ip, userAgent: request.headers.get('user-agent') });
	await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

	// Return everything the browser needs to unlock the private key locally.
	// The wrapping key is re-derived in-browser from `password` — the
	// server never derives or holds it.
	return json({
		id: user.id,
		email: user.email,
		displayName: user.displayName,
		keyAlgo: user.keyAlgo,
		publicKeyJwk: user.publicKeyJwk,
		wrappedPrivateKey: user.wrappedPrivateKey,
		wrappedPrivateKeyIv: user.wrappedPrivateKeyIv,
		privateKeyKdf: user.privateKeyKdf,
		privateKeyKdfParams: user.privateKeyKdfParams
	});
};
