import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileAlgo } from '../types';

const state = vi.hoisted(() => ({ elapsed: 0, costs: { 'AES-GCM': 4, 'ChaCha20-Poly1305': 1 } as Record<string, number>, unavailable: new Set<string>() }));
vi.mock('../file-encryption', async (importOriginal) => {
	const original = await importOriginal<typeof import('../file-encryption')>();
	return { ...original, encryptChunk: vi.fn(async (bytes: Uint8Array, _key: Uint8Array, algo: FileAlgo) => {
		if (state.unavailable.has(algo)) throw new Error('Unavailable cipher');
		state.elapsed += state.costs[algo];
		return new Uint8Array(bytes.length + 16);
	}) };
});

beforeEach(() => {
	vi.resetModules(); vi.clearAllMocks();
	state.elapsed = 0; state.costs['AES-GCM'] = 4; state.costs['ChaCha20-Poly1305'] = 1; state.unavailable.clear();
	vi.stubGlobal('performance', { now: () => state.elapsed });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('automatic encryption choice', () => {
	it.each(['AES-GCM', 'ChaCha20-Poly1305'] as const)('chooses %s when that implementation is faster', async (faster) => {
		state.costs[faster] = 0.5;
		state.costs[faster === 'AES-GCM' ? 'ChaCha20-Poly1305' : 'AES-GCM'] = 5;
		const { chooseAutoEncryption } = await import('../auto-encryption');
		expect(await chooseAutoEncryption(1000)).toBe(faster);
		const { encryptChunk } = await import('../file-encryption');
		expect(new Set(vi.mocked(encryptChunk).mock.calls.map((call) => call[2]))).toEqual(new Set(['AES-GCM', 'ChaCha20-Poly1305']));
	});

	it('uses the available implementation if the other cannot encrypt', async () => {
		state.unavailable.add('AES-GCM');
		const { chooseAutoEncryption } = await import('../auto-encryption');
		expect(await chooseAutoEncryption(1000)).toBe('ChaCha20-Poly1305');
	});

	it('rejects when neither works and retries a failed selection after availability returns', async () => {
		state.unavailable.add('AES-GCM'); state.unavailable.add('ChaCha20-Poly1305');
		const { chooseAutoEncryption } = await import('../auto-encryption');
		await expect(chooseAutoEncryption(1000)).rejects.toThrow('Neither supported encryption method');
		state.unavailable.clear();
		expect(await chooseAutoEncryption(1000)).toBe('ChaCha20-Poly1305');
	});

	it('reuses a workload choice and refreshes it after five minutes', async () => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(0);
		const { chooseAutoEncryption } = await import('../auto-encryption');
		const { encryptChunk } = await import('../file-encryption');
		expect(await chooseAutoEncryption(1000)).toBe('ChaCha20-Poly1305');
		const count = vi.mocked(encryptChunk).mock.calls.length;
		await chooseAutoEncryption(2000);
		expect(vi.mocked(encryptChunk).mock.calls).toHaveLength(count);
		state.costs['AES-GCM'] = 0.25;
		now.mockReturnValue(300001);
		expect(await chooseAutoEncryption(1000)).toBe('AES-GCM');
	});

	it('measures large-file throughput with a bounded chunk sample', async () => {
		const { chooseAutoEncryption } = await import('../auto-encryption');
		const { encryptChunk } = await import('../file-encryption');
		await chooseAutoEncryption(5 * 1024 ** 3);
		const sizes = vi.mocked(encryptChunk).mock.calls.map((call) => call[0].length);
		expect(Math.max(...sizes)).toBe(2 * 1024 ** 2);
	});

	it('rejects an invalid workload without trying to encrypt', async () => {
		const { chooseAutoEncryption } = await import('../auto-encryption');
		const { encryptChunk } = await import('../file-encryption');
		await expect(chooseAutoEncryption(-1)).rejects.toThrow('Invalid encryption workload');
		expect(encryptChunk).not.toHaveBeenCalled();
	});
});
