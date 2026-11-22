import { CHUNK_SIZE_BYTES, type FileAlgo } from './types';
import { deriveChunkNonce, encryptChunk, generateFileKey, newBaseNonce } from './file-encryption';

const KiB = 1024;
const cache = new Map<number, { expiresAt: number; choice: Promise<FileAlgo> }>();
const algorithms: FileAlgo[] = ['AES-GCM', 'ChaCha20-Poly1305'];

/** Compare the actual browser implementations, using synthetic bytes and independent keys. */
async function benchmark(sampleBytes: number): Promise<FileAlgo> {
	const sample = new Uint8Array(sampleBytes);
	const repetitions = sampleBytes <= 4 * KiB ? 16 : sampleBytes < CHUNK_SIZE_BYTES ? 4 : 2;
	const candidates = algorithms.map((algo) => ({ algo, key: generateFileKey(), nonce: newBaseNonce(), counter: 0, timings: [] as number[], available: true }));
	async function encrypt(candidate: (typeof candidates)[number]) {
		await encryptChunk(sample, candidate.key, candidate.algo, deriveChunkNonce(candidate.nonce, candidate.counter++));
	}
	try {
		// Warm both implementations before timing so WASM loading doesn't decide the winner.
		for (const candidate of candidates) {
			try { await encrypt(candidate); } catch { candidate.available = false; }
		}
		for (let round = 0; round < 3; round++) {
			for (const candidate of round % 2 ? [...candidates].reverse() : candidates) {
				if (!candidate.available) continue;
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				try {
					const started = performance.now();
					for (let i = 0; i < repetitions; i++) await encrypt(candidate);
					candidate.timings.push(Math.max(0, performance.now() - started) / repetitions);
				} catch { candidate.available = false; }
			}
		}
		const ranked = candidates.filter((candidate) => candidate.available && candidate.timings.length === 3)
			.map((candidate) => ({ algo: candidate.algo, time: [...candidate.timings].sort((a, b) => a - b)[1] }))
			.sort((a, b) => a.time - b.time);
		if (!ranked.length) throw new Error('Neither supported encryption method is available in this browser.');
		return ranked[0].algo;
	} finally { for (const candidate of candidates) candidate.key.fill(0); }
}

/** Called only when an upload/import starts; cache by workload size for five minutes. */
export function chooseAutoEncryption(sizeBytes: number): Promise<FileAlgo> {
	if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return Promise.reject(new Error('Invalid encryption workload size.'));
	const sampleBytes = sizeBytes <= 32 * KiB ? 4 * KiB : sizeBytes <= 512 * KiB ? 128 * KiB : CHUNK_SIZE_BYTES;
	const cached = cache.get(sampleBytes);
	if (cached && cached.expiresAt > Date.now()) return cached.choice;
	const choice: Promise<FileAlgo> = benchmark(sampleBytes).catch((error) => {
		if (cache.get(sampleBytes)?.choice === choice) cache.delete(sampleBytes);
		throw error;
	});
	cache.set(sampleBytes, { choice, expiresAt: Date.now() + 5 * 60_000 });
	return choice;
}
