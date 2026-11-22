// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) plus the small crypto
// helpers around it. Pure functions only (no env access) so they can be
// unit-tested against the RFC test vectors; the env-aware glue lives in
// two-factor.ts.

import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(input: string): Uint8Array {
	const clean = input.replace(/[\s=-]/g, '').toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = B32.indexOf(ch);
		if (idx === -1) throw new Error('Invalid base32 character');
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

export function generateTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226) for a given counter. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const hmac = createHmac('sha1', secret).update(buf).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const bin =
		((hmac[offset] & 0x7f) << 24) |
		((hmac[offset + 1] & 0xff) << 16) |
		((hmac[offset + 2] & 0xff) << 8) |
		(hmac[offset + 3] & 0xff);
	return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
	return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secretB32: string, nowMs: number, digits = TOTP_DIGITS): string {
	return hotp(base32Decode(secretB32), totpStep(nowMs), digits);
}

/**
 * Verifies a code against the current step ±`window` steps (clock skew).
 * Returns the matched step, or null. `lastUsedStep` blocks replay: a code
 * from a step that was already accepted is rejected.
 */
export function verifyTotp(
	secretB32: string,
	code: string,
	opts: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {}
): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const secret = base32Decode(secretB32);
	const now = totpStep(opts.nowMs ?? Date.now());
	const window = opts.window ?? 1;
	const given = Buffer.from(code);
	let matched: number | null = null;
	// Check every step in the window (no early exit) so timing doesn't
	// reveal which step matched.
	for (let step = now - window; step <= now + window; step++) {
		const expected = Buffer.from(hotp(secret, step));
		if (timingSafeEqual(given, expected) && matched === null) matched = step;
	}
	if (matched === null) return null;
	if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return null;
	return matched;
}

export function otpauthUri(secretB32: string, accountEmail: string, issuer = 'OverDrive'): string {
	const label = encodeURIComponent(`${issuer}:${accountEmail}`);
	return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// --- AES-256-GCM box for storing the TOTP secret at rest -------------------

/** Encrypts `plaintext` with a 32-byte key; output is base64(iv | tag | ciphertext). */
export function sealSecret(key: Uint8Array, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function openSecret(key: Uint8Array, sealed: string): string {
	const raw = Buffer.from(sealed, 'base64');
	const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	decipher.setAuthTag(raw.subarray(12, 28));
	return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
