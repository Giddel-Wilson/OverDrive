import { json, error } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { db, users } from '$server/db';
import { hashPassword, createSessionCookie } from '$server/auth-server';
import { configuredRegistrationMode } from '$server/admin';
import { redeemInvite, releaseInvite } from '$server/invites';
import { logAccess } from '$server/access-log';
import { recentFailedLoginCount, LOGIN_RATE_LIMIT } from '$server/rate-limit';
import { parseBody } from '$server/validate';
import { hashRecoveryToken } from '$server/recovery';
import { registerSchema } from '$server/schemas';
import type { RequestHandler } from './$types';

/**
 * Expects the browser to have already, client-side:
 *  1. generated an RSA-OAEP or ECDH keypair
 *  2. derived a wrapping key from the same password via Argon2id/PBKDF2
 *  3. encrypted the private key with that wrapping key
 *
 * This endpoint never sees a private key in usable form — only the
 * already-wrapped ciphertext plus the public key.
 *
 * Who may sign up (REGISTRATION_MODE, default "invite"): on an empty
 * deployment the first account is always allowed (that's the admin);
 * afterwards it needs a valid invite code, unless the mode is "open", and
 * nobody can sign up when it's "closed".
 */
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const {
		email,
		displayName,
		password,
		publicKeyJwk,
		keyAlgo,
		wrappedPrivateKey,
		wrappedPrivateKeyIv,
		privateKeyKdf,
		privateKeyKdfParams,
		recoveryWrappedPrivateKey,
		recoveryIv,
		recoveryAuthToken,
		inviteCode
	} = parseBody(registerSchema, await request.json());
	const ip = getClientAddress();

	const [{ n: userCount }] = await db.select({ n: count() }).from(users);
	const mode = userCount === 0 ? 'open' : configuredRegistrationMode();
	if (mode === 'closed') error(403, 'Sign-ups are closed on this server');

	// Checked before an invite is consumed, so a taken email never burns a code.
	const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
	if (existing) error(409, 'An account with that email already exists');

	let invite: Awaited<ReturnType<typeof redeemInvite>> = null;
	if (mode === 'invite') {
		// Wrong codes count toward the same per-IP lockout as wrong passwords.
		if ((await recentFailedLoginCount(ip)) >= LOGIN_RATE_LIMIT.maxAttempts) {
			error(429, 'Too many failed attempts. Try again in a few minutes.');
		}
		if (!inviteCode) error(403, 'An invite code is required to sign up');
		invite = await redeemInvite(inviteCode);
		if (!invite) {
			await logAccess({ actorId: null, action: 'DECRYPT_ATTEMPT', success: false, failureReason: 'bad_invite', ipAddress: ip });
			error(403, "That invite code isn't valid, has expired, or has already been used");
		}
	}

	let user: { id: string; email: string };
	try {
		const authHash = await hashPassword(password);
		[user] = await db
			.insert(users)
			.values({
				email,
				displayName: displayName || email.split('@')[0],
				authHash,
				authSalt: '', // unused: @node-rs/argon2 embeds its own salt in the hash string
				authKdf: 'Argon2id',
				publicKeyJwk,
				keyAlgo,
				wrappedPrivateKey,
				wrappedPrivateKeyIv,
				privateKeyKdf,
				privateKeyKdfParams,
				inviteId: invite?.id ?? null,
				storageQuotaBytes: invite?.quotaBytes ?? null,
				// Recovery material is all-or-nothing: a wrapped key without its proof
				// token (or vice versa) would be unusable, so store both or neither.
				...(recoveryWrappedPrivateKey && recoveryIv && recoveryAuthToken
					? {
							recoveryWrappedPrivateKey,
							recoveryIv,
							recoveryAuthHash: hashRecoveryToken(recoveryAuthToken)
						}
					: {})
			})
			.returning({ id: users.id, email: users.email });
	} catch (err) {
		// The sign-up failed after the code was consumed — give the use back.
		if (invite) await releaseInvite(invite.id);
		throw err;
	}

	await createSessionCookie(cookies, user.id, user.email, { ip, userAgent: request.headers.get('user-agent') });

	return json({ id: user.id, email: user.email });
};
