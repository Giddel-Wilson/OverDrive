import { toBase64, fromBase64 } from './encoding';
import { RECOVERY_SALT_V1 } from '../shared/legacy-protocol.js';

/**
 * Account recovery key.
 *
 * A random 256-bit secret, shown to the user once, from which two
 * independent values are derived with HKDF-SHA256:
 *   - an AES-GCM key that wraps a second copy of the private key
 *   - a proof token the server can check (it stores only SHA-256 of it)
 * The server never sees the recovery key. Because it is 256 bits of true
 * randomness there is nothing to brute-force, so — unlike a password — no
 * slow KDF is needed.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HKDF_SALT = new TextEncoder().encode(RECOVERY_SALT_V1);

export function generateRecoveryKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

/** 32 bytes → 52 base32 characters, grouped for reading aloud / printing. */
export function formatRecoveryKey(key: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of key) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out.match(/.{1,4}/g)!.join('-');
}

/** Forgiving parser: ignores case, spaces and dashes; maps 0→O and 1→I (neither is in the alphabet). */
export function parseRecoveryKey(input: string): Uint8Array {
	const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
	if (clean.length !== 52) throw new Error('A recovery key is 52 characters (13 groups of 4).');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = B32.indexOf(ch);
		if (idx === -1) throw new Error(`Unexpected character "${ch}" in recovery key.`);
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out.slice(0, 32));
}

async function hkdf(recoveryKey: Uint8Array, info: string): Promise<ArrayBuffer> {
	const base = await crypto.subtle.importKey('raw', recoveryKey as BufferSource, 'HKDF', false, ['deriveBits']);
	return crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT as BufferSource, info: new TextEncoder().encode(info) as BufferSource },
		base,
		256
	);
}

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function deriveRecoveryMaterial(recoveryKey: Uint8Array) {
	const encBits = await hkdf(recoveryKey, 'wrap-private-key');
	const authBits = await hkdf(recoveryKey, 'server-proof');
	return {
		authToken: toHex(authBits),
		encKey: (usage: KeyUsage[]) => crypto.subtle.importKey('raw', encBits, 'AES-GCM', false, usage)
	};
}

/** Encrypts the private key (as JWK) under the recovery key. */
export async function wrapPrivateKeyWithRecovery(privateKeyJwk: JsonWebKey, recoveryKey: Uint8Array) {
	const { authToken, encKey } = await deriveRecoveryMaterial(recoveryKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as BufferSource },
		await encKey(['encrypt']),
		new TextEncoder().encode(JSON.stringify(privateKeyJwk)) as BufferSource
	);
	return {
		recoveryWrappedPrivateKey: toBase64(new Uint8Array(ct)),
		recoveryIv: toBase64(iv),
		recoveryAuthToken: authToken
	};
}

/** Opens the recovery-wrapped private key; throws a friendly error on a wrong key. */
export async function unwrapPrivateKeyWithRecovery(
	recoveryWrappedPrivateKey: string,
	recoveryIv: string,
	recoveryKey: Uint8Array
): Promise<{ privateKeyJwk: JsonWebKey; authToken: string }> {
	const { authToken, encKey } = await deriveRecoveryMaterial(recoveryKey);
	try {
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(recoveryIv) as BufferSource },
			await encKey(['decrypt']),
			fromBase64(recoveryWrappedPrivateKey) as BufferSource
		);
		return { privateKeyJwk: JSON.parse(new TextDecoder().decode(pt)), authToken };
	} catch {
		throw new Error('That recovery key does not match this account.');
	}
}

/** Plain-text kit the user can save or print. Contains the recovery key — treat as a secret. */
export function recoveryKitText(email: string, formattedKey: string): string {
	return [
		'OverDrive — Recovery Kit',
		'================================',
		'',
		`Account:       ${email}`,
		`Recovery key:  ${formattedKey}`,
		`Created:       ${new Date().toISOString().slice(0, 10)}`,
		'',
		'WHAT THIS IS',
		'If you forget your password, this key is the ONLY way back into your',
		'files. We cannot reset your password for you — we never hold anything',
		'that could decrypt your data.',
		'',
		'HOW TO USE IT',
		'On the sign-in page choose "Forgot password", enter your email, this',
		'key, and a new password. Your files stay exactly as they are.',
		'',
		'KEEP IT SAFE',
		'- Store it offline (printed, or in a password manager) — not in this vault.',
		'- Anyone who has this key and your email can take over your account.',
		'- Generating a new key from Account settings invalidates this one.'
	].join('\n');
}
