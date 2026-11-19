import { hkdfSync } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { sealSecret, openSecret } from './totp';

function atRestKey(): Uint8Array {
	if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
		throw new Error('SESSION_SECRET is not set (or too short) — set it in your env vars');
	}
	// Domain-separated from the JWT signing use of the same secret.
	return new Uint8Array(hkdfSync('sha256', env.SESSION_SECRET, 'e2e-totp', 'totp-secret-at-rest', 32));
}

export const sealTotpSecret = (secretB32: string) => sealSecret(atRestKey(), secretB32);
export const openTotpSecret = (sealed: string) => openSecret(atRestKey(), sealed);
