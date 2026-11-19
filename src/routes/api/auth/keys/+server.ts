import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, users } from '$server/db';
import { requireUser } from '$server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const sessionUser = requireUser(locals);
	const [user] = await db
		.select({
			keyAlgo: users.keyAlgo,
			publicKeyJwk: users.publicKeyJwk,
			wrappedPrivateKey: users.wrappedPrivateKey,
			wrappedPrivateKeyIv: users.wrappedPrivateKeyIv,
			privateKeyKdf: users.privateKeyKdf,
			privateKeyKdfParams: users.privateKeyKdfParams,
			recoveryAuthHash: users.recoveryAuthHash,
			totpEnabled: users.totpEnabled
		})
		.from(users)
		.where(eq(users.id, sessionUser.id));

	const { recoveryAuthHash, ...rest } = user;
	// Booleans only — the account page needs to know whether a recovery key
	// and 2FA exist, never their values.
	return json({ ...rest, hasRecoveryKey: recoveryAuthHash !== null, totpEnabled: user.totpEnabled });
};
