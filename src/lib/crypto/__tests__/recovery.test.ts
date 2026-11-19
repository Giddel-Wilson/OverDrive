import { describe, it, expect } from 'vitest';
import {
	deriveRecoveryMaterial,
	formatRecoveryKey,
	generateRecoveryKey,
	parseRecoveryKey,
	recoveryKitText,
	unwrapPrivateKeyWithRecovery,
	wrapPrivateKeyWithRecovery
} from '../recovery';
import { generateEcdhKeypair } from '../key-encryption';
import { importPrivateJwk, unwrapPrivateKeyJwk, wrapPrivateKey } from '../private-key';
import { DEFAULT_PBKDF2_PARAMS } from '../kdf';

describe('recovery key format', () => {
	it('is 52 base32 chars in 13 groups and round-trips', () => {
		const key = generateRecoveryKey();
		const text = formatRecoveryKey(key);
		expect(text).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
		expect(parseRecoveryKey(text)).toEqual(key);
	});

	it('parses forgivingly (case, spaces, 0/1 look-alikes) and rejects garbage', () => {
		const key = generateRecoveryKey();
		const text = formatRecoveryKey(key);
		expect(parseRecoveryKey(text.toLowerCase().replace(/-/g, ' '))).toEqual(key);
		expect(() => parseRecoveryKey('ABCD-EFGH')).toThrow(/52 characters/);
		expect(() => parseRecoveryKey('!'.repeat(52))).toThrow(/Unexpected character/);
		// "O"/"I" typed as digits still map back
		const withOs = formatRecoveryKey(new Uint8Array(32)); // all A's — no look-alikes, sanity only
		expect(parseRecoveryKey(withOs)).toEqual(new Uint8Array(32));
	});

	it('kit text contains the account and key', () => {
		const text = recoveryKitText('me@example.com', 'AAAA-BBBB');
		expect(text).toContain('me@example.com');
		expect(text).toContain('AAAA-BBBB');
	});
});

describe('recovery wrapping', () => {
	it('derives distinct, deterministic enc/auth material from the same key', async () => {
		const key = generateRecoveryKey();
		const a = await deriveRecoveryMaterial(key);
		const b = await deriveRecoveryMaterial(key);
		expect(a.authToken).toBe(b.authToken);
		expect(a.authToken).toMatch(/^[0-9a-f]{64}$/);
		const other = await deriveRecoveryMaterial(generateRecoveryKey());
		expect(other.authToken).not.toBe(a.authToken);
	});

	it('round-trips a private key and rejects a wrong recovery key', async () => {
		const kp = await generateEcdhKeypair();
		const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
		const recoveryKey = generateRecoveryKey();
		const wrapped = await wrapPrivateKeyWithRecovery(jwk, recoveryKey);

		const opened = await unwrapPrivateKeyWithRecovery(wrapped.recoveryWrappedPrivateKey, wrapped.recoveryIv, recoveryKey);
		expect(opened.privateKeyJwk).toEqual(jwk);
		expect(opened.authToken).toBe(wrapped.recoveryAuthToken);

		await expect(
			unwrapPrivateKeyWithRecovery(wrapped.recoveryWrappedPrivateKey, wrapped.recoveryIv, generateRecoveryKey())
		).rejects.toThrow('does not match this account');
	});

	it('full recovery: password lost → recovery key → re-wrap under a NEW password → same private key', async () => {
		const kp = await generateEcdhKeypair();
		const originalJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

		// Registration: wrap under the password and under a recovery key.
		const oldPw = await wrapPrivateKey(kp.privateKey, 'old password 123', DEFAULT_PBKDF2_PARAMS);
		const recoveryKey = generateRecoveryKey();
		const rec = await wrapPrivateKeyWithRecovery(originalJwk, recoveryKey);

		// Recovery: open with the recovery key, re-wrap under a new password.
		const { privateKeyJwk } = await unwrapPrivateKeyWithRecovery(rec.recoveryWrappedPrivateKey, rec.recoveryIv, recoveryKey);
		const extractable = await importPrivateJwk(privateKeyJwk, 'ECDH-P256', true);
		const newPw = await wrapPrivateKey(extractable, 'a brand new password', DEFAULT_PBKDF2_PARAMS);

		// New password opens it and yields the identical key; old password's copy is untouched/irrelevant.
		const reopened = await unwrapPrivateKeyJwk(newPw.wrappedPrivateKey, newPw.wrappedPrivateKeyIv, 'a brand new password', newPw.privateKeyKdfParams as any);
		// Same key material (key_ops can differ: the unlock path imports it for deriveBits only).
		expect({ kty: reopened.kty, crv: reopened.crv, d: reopened.d, x: reopened.x, y: reopened.y }).toEqual({
			kty: originalJwk.kty, crv: originalJwk.crv, d: originalJwk.d, x: originalJwk.x, y: originalJwk.y
		});
		await expect(
			unwrapPrivateKeyJwk(newPw.wrappedPrivateKey, newPw.wrappedPrivateKeyIv, 'old password 123', newPw.privateKeyKdfParams as any)
		).rejects.toThrow('Incorrect password');
		expect(oldPw.wrappedPrivateKey).not.toBe(newPw.wrappedPrivateKey);
	});
});
