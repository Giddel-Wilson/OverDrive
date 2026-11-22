import { vi } from 'vitest';
import { toBase64, fromBase64 } from '../encoding';
import type { EncryptedFileRecord } from '../download-pipeline';

interface StoredFile {
	init: Record<string, any>;
	chunks: Map<number, Uint8Array>;
	sha?: string;
	complete: boolean;
	versionNumber: number;
}

/**
 * In-memory stand-in for the app server + object storage, installed as the
 * global fetch. Implements the real upload protocol (init / presign / PUT to
 * presigned URL / relay PUT / status / finalize) and the chunk download
 * route, so pipeline code runs unmodified.
 */
export function installFakeServer(opts: { failDirectPut?: (fileId: string, index: number, attempt: number) => 'http500' | 'network' | null } = {}) {
	const files = new Map<string, StoredFile>();
	const versions = new Map<string, StoredFile[]>();
	const stats = { directPuts: 0, relayPuts: 0, presignCalls: 0, directAttempts: new Map<string, number>() };
	let nextId = 1;

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://app.test');
		const method = (init?.method ?? 'GET').toUpperCase();

		// --- direct (presigned) PUT to "object storage"
		if (url.host === 'b2.test' && method === 'PUT') {
			const [, fileId, chunk] = /^\/([^/]+)\/chunk-(\d+)$/.exec(url.pathname)!;
			const index = Number(chunk);
			const key = `${fileId}:${index}`;
			const attempt = (stats.directAttempts.get(key) ?? 0) + 1;
			stats.directAttempts.set(key, attempt);
			const fail = opts.failDirectPut?.(fileId, index, attempt);
			if (fail === 'network') throw new TypeError('Failed to fetch');
			if (fail === 'http500') return new Response('boom', { status: 500 });
			stats.directPuts++;
			files.get(fileId)!.chunks.set(index, new Uint8Array(init!.body as Uint8Array));
			return new Response(null, { status: 200 });
		}

		if (url.pathname === '/api/files/upload') {
			if (method === 'POST') {
				const body = JSON.parse(init!.body as string);
				if (body.action === 'init') {
					if (body.replacesFileId) {
						const current = files.get(body.replacesFileId);
						if (!current?.complete || current.versionNumber !== body.baseVersion) return json({ message: 'The current version changed' }, 409);
					}
					const id = `file-${nextId++}`;
					files.set(id, { init: body, chunks: new Map(), complete: false, versionNumber: 1 });
					return json({ fileId: id });
				}
				if (body.action === 'presign') {
					stats.presignCalls++;
					const urls: Record<number, string> = {};
					for (const i of body.indexes) urls[i] = `https://b2.test/${body.fileId}/chunk-${i}`;
					return json({ urls });
				}
				if (body.action === 'finalize') {
					const f = files.get(body.fileId)!;
					const missing = [...Array(f.init.totalChunks).keys()].filter((i) => !f.chunks.has(i));
					if (missing.length) return json({ message: `${missing.length} chunk(s) never reached storage`, missing }, 409);
					const replacedId = f.init.replacesFileId as string | undefined;
					const current = replacedId ? files.get(replacedId) : undefined;
					if (replacedId && (!current?.complete || current.versionNumber !== f.init.baseVersion)) return json({ message: 'The current version changed' }, 409);
					f.sha = body.ciphertextSha256;
					f.complete = true;
					if (replacedId && current) {
						versions.set(replacedId, [...(versions.get(replacedId) ?? []), current]);
						f.versionNumber = current.versionNumber + 1;
						files.set(replacedId, f);
						files.delete(body.fileId);
					}
					return json({ ok: true, fileId: replacedId ?? body.fileId, versionNumber: f.versionNumber });
				}
			}
			if (method === 'PUT') {
				const h = new Headers(init!.headers);
				const fileId = h.get('X-File-Id')!;
				const index = Number(h.get('X-Chunk-Index'));
				stats.relayPuts++;
				files.get(fileId)!.chunks.set(index, fromBase64(JSON.parse(init!.body as string).chunk));
				return json({ ok: true });
			}
			if (method === 'GET') {
				const f = files.get(url.searchParams.get('fileId')!)!;
				return json({ status: f.complete ? 'complete' : 'uploading', totalChunks: f.init.totalChunks, uploaded: [...f.chunks.keys()].sort((a, b) => a - b) });
			}
		}

		const archived = /^\/api\/files\/([^/]+)\/versions\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
		if (archived) {
			const version = versions.get(archived[1])?.find((entry) => `${archived[1]}-v${entry.versionNumber}` === archived[2]);
			const chunk = version?.chunks.get(Number(archived[3]));
			return chunk ? json({ chunk: toBase64(chunk) }) : json({ message: 'missing version chunk' }, 404);
		}
		const m = /^\/api\/files\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
		if (m) {
			const chunk = files.get(m[1])?.chunks.get(Number(m[2]));
			return chunk ? json({ chunk: toBase64(chunk) }) : json({ message: 'missing' }, 404);
		}
		return json({ message: `unhandled ${method} ${url.pathname}` }, 500);
	};

	vi.stubGlobal('fetch', vi.fn(impl));

	function record(fileId: string, entry = files.get(fileId)!): EncryptedFileRecord {
		return {
			id: fileId,
			versionNumber: entry.versionNumber,
			fileAlgo: entry.init.fileAlgo,
			fileIv: entry.init.fileIv,
			keyAlgo: entry.init.keyAlgo,
			wrappedFileKey: entry.init.wrappedFileKey,
			keyWrapIv: entry.init.wrapIv,
			keyWrapEphemeralPublicKeyJwk: entry.init.ephemeralPublicKeyJwk,
			totalChunks: entry.init.totalChunks,
			ciphertextSha256: entry.sha,
			uploadStatus: entry.complete ? 'complete' : 'uploading',
			metadata: { encryptedBlob: entry.init.metadata.encryptedBlob, iv: entry.init.metadata.iv, algo: entry.init.metadata.algo }
		};
	}

	return {
		files,
		versions,
		stats,
		/** Rebuilds the record GET /api/files would return for a finished (or pending) upload. */
		record,
		versionRecord(fileId: string, versionNumber: number): EncryptedFileRecord {
			const version = versions.get(fileId)?.find((entry) => entry.versionNumber === versionNumber);
			if (!version) throw new Error('Unknown archived version');
			return { ...record(`${fileId}-v${versionNumber}`, version), versionOf: fileId };
		},
		restore() {
			vi.unstubAllGlobals();
		}
	};
}

/** crypto.getRandomValues is capped at 64 KiB per call. */
export function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
	return out;
}
