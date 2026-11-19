import { toBase64, fromBase64 } from './encoding';
import { decryptBlob, encryptBlob, generateFileKey } from './file-encryption';
import { unwrapFileKey, wrapFileKey } from './key-encryption';
import { unwrapRecordFileKey, type EncryptedFileRecord } from './download-pipeline';
import type { FileAlgo, KeyAlgo } from './types';

// ---------------------------------------------------------------------------
// Folder model. Like file metadata, a folder's name and parent live inside
// an encrypted blob — the server only knows that N folder rows exist.
// ---------------------------------------------------------------------------

export interface FolderRecord {
	id: string;
	encryptedBlob: string;
	iv: string;
	algo: FileAlgo;
	wrappedKey: string;
	keyAlgo: KeyAlgo;
	keyWrapIv: string | null;
	keyWrapEphemeralPublicKeyJwk: JsonWebKey | null;
	createdAt?: string;
	deletedAt?: string | null;
}

export interface FolderMeta {
	name: string;
	parentId: string | null;
}

export type FolderMap = Map<string, FolderMeta>;

async function unwrapFolderKey(record: FolderRecord, privateKey: CryptoKey): Promise<Uint8Array> {
	if (record.keyAlgo === 'RSA-OAEP') {
		return unwrapFileKey({ wrapped: fromBase64(record.wrappedKey), algo: 'RSA-OAEP' }, privateKey);
	}
	if (!record.keyWrapIv || !record.keyWrapEphemeralPublicKeyJwk) throw new Error('Folder is missing ECDH wrap material');
	return unwrapFileKey(
		{
			wrapped: fromBase64(record.wrappedKey),
			algo: 'ECDH-P256',
			iv: fromBase64(record.keyWrapIv),
			ephemeralPublicKeyJwk: record.keyWrapEphemeralPublicKeyJwk
		},
		privateKey
	);
}

/** Builds the body for POST /api/folders: a fresh folder key, wrapped for the owner, plus the encrypted name/parent. */
export async function createFolderPayload(
	name: string,
	parentId: string | null,
	keyAlgo: KeyAlgo,
	publicKey: CryptoKey
) {
	const folderKey = generateFileKey();
	const algo: FileAlgo = 'AES-GCM';
	const { ciphertext, iv } = await encryptBlob(
		new TextEncoder().encode(JSON.stringify({ name, parentId } satisfies FolderMeta)),
		folderKey,
		algo
	);
	const wrapped = await wrapFileKey(folderKey, keyAlgo, publicKey);
	return {
		encryptedBlob: toBase64(ciphertext),
		iv: toBase64(iv),
		algo,
		wrappedKey: toBase64(wrapped.wrapped),
		keyAlgo,
		keyWrapIv: wrapped.iv ? toBase64(wrapped.iv) : null,
		keyWrapEphemeralPublicKeyJwk: wrapped.ephemeralPublicKeyJwk ?? null
	};
}

export async function decryptFolderMeta(record: FolderRecord, privateKey: CryptoKey): Promise<FolderMeta> {
	const key = await unwrapFolderKey(record, privateKey);
	const pt = await decryptBlob(fromBase64(record.encryptedBlob), key, record.algo, fromBase64(record.iv));
	return JSON.parse(new TextDecoder().decode(pt));
}

/** Decrypt → patch → re-encrypt a folder's blob (rename / move). Returns the body for PATCH /api/folders/[id]. */
export async function reencryptFolderMeta(record: FolderRecord, privateKey: CryptoKey, patch: Partial<FolderMeta>) {
	const key = await unwrapFolderKey(record, privateKey);
	const current: FolderMeta = JSON.parse(
		new TextDecoder().decode(await decryptBlob(fromBase64(record.encryptedBlob), key, record.algo, fromBase64(record.iv)))
	);
	const { ciphertext, iv } = await encryptBlob(new TextEncoder().encode(JSON.stringify({ ...current, ...patch })), key, record.algo);
	return { encryptedBlob: toBase64(ciphertext), iv: toBase64(iv) };
}

/** Same for a file's metadata blob. Returns the body for PATCH /api/files/[id]. */
export async function reencryptFileMeta(
	record: EncryptedFileRecord,
	privateKey: CryptoKey,
	patch: { name?: string; folderId?: string | null }
) {
	if (!record.metadata) throw new Error('This file has no metadata to update');
	const key = await unwrapRecordFileKey(record, privateKey);
	const current = JSON.parse(
		new TextDecoder().decode(
			await decryptBlob(fromBase64(record.metadata.encryptedBlob), key, record.metadata.algo, fromBase64(record.metadata.iv))
		)
	);
	const { ciphertext, iv } = await encryptBlob(
		new TextEncoder().encode(JSON.stringify({ ...current, ...patch })),
		key,
		record.metadata.algo
	);
	return { encryptedBlob: toBase64(ciphertext), iv: toBase64(iv) };
}

// ---------------------------------------------------------------------------
// Pure tree helpers (no crypto) — everything the Vault UI needs to navigate,
// search, move and trash, computed in the browser because only the browser
// can read the folder tree.
// ---------------------------------------------------------------------------

/** Root → … → folder, as [{id, name}]. Cycle-safe. */
export function folderPath(id: string | null, folders: FolderMap): { id: string; name: string }[] {
	const out: { id: string; name: string }[] = [];
	const seen = new Set<string>();
	let cur = id;
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		const f = folders.get(cur);
		if (!f) break;
		out.unshift({ id: cur, name: f.name });
		cur = f.parentId;
	}
	return out;
}

/** Every folder id underneath `rootId` (not including it). */
export function descendantFolderIds(rootId: string, folders: FolderMap): string[] {
	const children = new Map<string | null, string[]>();
	for (const [id, f] of folders) {
		const list = children.get(f.parentId) ?? [];
		list.push(id);
		children.set(f.parentId, list);
	}
	const out: string[] = [];
	const stack = [...(children.get(rootId) ?? [])];
	while (stack.length) {
		const id = stack.pop()!;
		if (out.includes(id)) continue;
		out.push(id);
		stack.push(...(children.get(id) ?? []));
	}
	return out;
}

/** A folder can't be moved into itself or anything beneath it. */
export function isValidFolderMoveTarget(movingId: string, targetParentId: string | null, folders: FolderMap): boolean {
	if (targetParentId === null) return true;
	if (targetParentId === movingId) return false;
	return !descendantFolderIds(movingId, folders).includes(targetParentId);
}

/** Ancestor chain of a folder (parents first), excluding itself. */
export function ancestorIds(id: string | null, folders: FolderMap): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let cur = id ? folders.get(id)?.parentId ?? null : null;
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		out.push(cur);
		cur = folders.get(cur)?.parentId ?? null;
	}
	return out;
}

export interface NamedEntry {
	kind: 'folder' | 'file';
	id: string;
	name: string;
	parentId: string | null;
	size?: number;
	createdAt?: string;
}

export function sortEntries(entries: NamedEntry[], by: 'name' | 'newest' | 'size'): NamedEntry[] {
	const byName = (a: NamedEntry, b: NamedEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
	return [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1; // folders first
		if (by === 'newest') return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || byName(a, b);
		if (by === 'size') return (b.size ?? 0) - (a.size ?? 0) || byName(a, b);
		return byName(a, b);
	});
}

/** Case-insensitive substring match over decrypted names — the whole "search index" lives in memory. */
export function searchEntries(query: string, entries: NamedEntry[]): NamedEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/** Files directly in `folderId` plus its subfolders — everything a folder trash must carry along. */
export function collectSubtree(rootFolderId: string, folders: FolderMap, files: { id: string; folderId: string | null }[]) {
	const folderIds = [rootFolderId, ...descendantFolderIds(rootFolderId, folders)];
	const set = new Set(folderIds);
	return { folderIds, fileIds: files.filter((f) => f.folderId && set.has(f.folderId)).map((f) => f.id) };
}
