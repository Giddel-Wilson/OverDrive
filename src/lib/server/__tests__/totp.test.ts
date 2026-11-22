import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { base32Decode, base32Encode, generateTotpSecret, hotp, openSecret, sealSecret, totpAt, verifyTotp, otpauthUri } from '../totp';

// RFC 6238 Appendix B: SHA-1 secret is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
	it('matches the RFC 6238 SHA-1 test vectors (8 digits)', () => {
		const vectors: [number, string][] = [
			[59, '94287082'],
			[1111111109, '07081804'],
			[1111111111, '14050471'],
			[1234567890, '89005924'],
			[2000000000, '69279037'],
			[20000000000, '65353130']
		];
		for (const [t, expected] of vectors) expect(totpAt(RFC_SECRET, t * 1000, 8)).toBe(expected);
	});

	it('matches RFC 4226 HOTP vectors (6 digits)', () => {
		const secret = new TextEncoder().encode('12345678901234567890');
		const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
		expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
	});

	it('base32 round-trips', () => {
		const bytes = randomBytes(20);
		expect(Buffer.from(base32Decode(base32Encode(bytes)))).toEqual(bytes);
		expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
	});

	it('accepts the current code and ±1 step, rejects further skew', () => {
		const now = 1_700_000_000_000;
		const code = totpAt(RFC_SECRET, now);
		expect(verifyTotp(RFC_SECRET, code, { nowMs: now })).not.toBeNull();
		expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 30_000 })).not.toBeNull();
		expect(verifyTotp(RFC_SECRET, code, { nowMs: now - 30_000 })).not.toBeNull();
		expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 90_000 })).toBeNull();
	});

	it('rejects replay of an already-used step and malformed codes', () => {
		const now = 1_700_000_000_000;
		const code = totpAt(RFC_SECRET, now);
		const step = verifyTotp(RFC_SECRET, code, { nowMs: now })!;
		expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastUsedStep: step })).toBeNull();
		expect(verifyTotp(RFC_SECRET, '12345', { nowMs: now })).toBeNull();
		expect(verifyTotp(RFC_SECRET, 'abcdef', { nowMs: now })).toBeNull();
	});

	it('builds an otpauth URI authenticator apps accept', () => {
		const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'a@b.com');
		expect(uri).toBe(
			'otpauth://totp/OverDrive%3Aa%40b.com?secret=JBSWY3DPEHPK3PXP&issuer=OverDrive&algorithm=SHA1&digits=6&period=30'
		);
	});
});

describe('secret sealing', () => {
	const key = randomBytes(32);
	it('round-trips and uses a fresh IV each time', () => {
		const a = sealSecret(key, 'JBSWY3DPEHPK3PXP');
		const b = sealSecret(key, 'JBSWY3DPEHPK3PXP');
		expect(a).not.toBe(b);
		expect(openSecret(key, a)).toBe('JBSWY3DPEHPK3PXP');
	});
	it('fails with a wrong key or tampered ciphertext', () => {
		const sealed = sealSecret(key, 'JBSWY3DPEHPK3PXP');
		expect(() => openSecret(randomBytes(32), sealed)).toThrow();
		const raw = Buffer.from(sealed, 'base64');
		raw[raw.length - 1] ^= 1;
		expect(() => openSecret(key, raw.toString('base64'))).toThrow();
	});
});
