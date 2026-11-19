import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

/** SHA-256 hex of the client-derived recovery proof token. The token is
 * already 256 bits of HKDF output, so a fast hash is the right tool here
 * (there is nothing to brute-force) — and the server never sees the
 * recovery key itself, only this proof. */
export function hashRecoveryToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function recoveryTokenMatches(storedHash: string, token: string): boolean {
	const a = Buffer.from(storedHash, 'hex');
	const b = Buffer.from(hashRecoveryToken(token), 'hex');
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deterministic, plausible-looking stand-in returned for emails that have
 * no recovery material, so GET /api/auth/recover can't be used to learn
 * which emails are registered. The same email always yields the same
 * bytes, so repeated probing reveals nothing either.
 */
export function decoyRecoveryBlob(email: string): {
	keyAlgo: 'RSA-OAEP' | 'ECDH-P256';
	recoveryWrappedPrivateKey: string;
	recoveryIv: string;
} {
	const secret = env.SESSION_SECRET ?? 'dev-only-decoy';
	const block = (label: string, i: number) =>
		createHmac('sha256', secret).update(`recovery-decoy:${label}:${email}:${i}`).digest();
	const expand = (label: string, length: number) => {
		const parts: Buffer[] = [];
		for (let i = 0; parts.length * 32 < length; i++) parts.push(block(label, i));
		return Buffer.concat(parts).subarray(0, length);
	};
	const rsa = block('algo', 0)[0] % 2 === 0;
	return {
		keyAlgo: rsa ? 'RSA-OAEP' : 'ECDH-P256',
		recoveryWrappedPrivateKey: expand('key', rsa ? 3222 : 266).toString('base64'),
		recoveryIv: expand('iv', 12).toString('base64')
	};
}
