import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db, invites } from './db';
import { base32Encode } from './totp';

/** 80 random bits as XXXX-XXXX-XXXX-XXXX. */
export function generateInviteCode(): string {
	return base32Encode(randomBytes(10)).match(/.{1,4}/g)!.join('-');
}

/** Case, dashes and spaces don't matter when someone types a code in. */
export const normalizeInviteCode = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '');

export const hashInviteCode = (code: string) =>
	createHash('sha256').update(`invite:${normalizeInviteCode(code)}`).digest('hex');

/**
 * Atomically consumes one use of a valid invite. A single conditional UPDATE
 * does the "is it still valid?" check and the increment together, so two
 * people can't both redeem the last use of a single-use code.
 */
export async function redeemInvite(code: string): Promise<typeof invites.$inferSelect | null> {
	const [row] = await db
		.update(invites)
		.set({ uses: sql`${invites.uses} + 1` })
		.where(
			and(
				eq(invites.codeHash, hashInviteCode(code)),
				isNull(invites.revokedAt),
				or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
				lt(invites.uses, invites.maxUses)
			)
		)
		.returning();
	return row ?? null;
}

/** Gives a use back (the sign-up that consumed it failed afterwards). */
export async function releaseInvite(id: string) {
	await db
		.update(invites)
		.set({ uses: sql`greatest(${invites.uses} - 1, 0)` })
		.where(eq(invites.id, id));
}
