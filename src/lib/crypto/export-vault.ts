import { ZipWriter } from './zip-writer';
import {
	decryptFileToSink,
	decryptRecordMetadata,
	unwrapRecordFileKey,
	type ChunkFetcher,
	type EncryptedFileRecord,
	type PlaintextSink
} from './download-pipeline';
import { decryptFolderMeta, folderPath, type FolderMap, type FolderRecord } from './vault';

export interface ExportProgress {
	phase: 'preparing' | 'exporting' | 'finalizing' | 'done';
	fileIndex: number;
	fileCount: number;
	currentName: string;
	percent: number;
}

export interface ExportResult {
	exported: number;
	failed: { path: string; reason: string }[];
}

/** Makes one path segment safe on Windows, macOS and Linux. */
export function sanitizeSegment(name: string): string {
	const cleaned = name
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(0, 120);
	return cleaned || 'unnamed';
}

/** Splits "a.tar.gz" → ["a", ".tar.gz"]-ish: keeps only the final extension. */
function splitExt(name: string): [string, string] {
	const i = name.lastIndexOf('.');
	return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/** Adds " (2)", " (3)"… until the path is unique (case-insensitive, as most filesystems are). */
export function uniquePath(path: string, taken: Set<string>): string {
	let candidate = path;
	let n = 2;
	const [base, ext] = splitExt(path);
	while (taken.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`;
	taken.add(candidate.toLowerCase());
	return candidate;
}

/**
 * Decrypts the whole vault in the browser and streams it into a ZIP with
 * the original folder structure. Nothing is sent anywhere: ciphertext is
 * fetched, verified and decrypted chunk by chunk into `sink`, so memory
 * stays flat when the sink is a file on disk.
 *
 * Trashed items and unfinished uploads are not included. A file that fails
 * to download or verify is listed in EXPORT-REPORT.txt inside the archive
 * (its entry may be incomplete) instead of aborting the whole export.
 */
export async function exportVault(opts: {
	files: EncryptedFileRecord[];
	folders: FolderRecord[];
	privateKey: CryptoKey;
	sink: PlaintextSink;
	fetchChunkFor?: (fileId: string) => ChunkFetcher;
	onProgress?: (p: ExportProgress) => void;
	signal?: AbortSignal;
	zip64ForTesting?: boolean;
}): Promise<ExportResult> {
	const { files, folders, privateKey, sink, onProgress, signal } = opts;
	const report = (p: Partial<ExportProgress> & Pick<ExportProgress, 'phase'>) =>
		onProgress?.({ fileIndex: 0, fileCount: files.length, currentName: '', percent: 0, ...p });

	report({ phase: 'preparing' });

	// Folder tree → path lookup.
	const folderMap: FolderMap = new Map();
	for (const rec of folders) {
		signal?.throwIfAborted();
		folderMap.set(rec.id, await decryptFolderMeta(rec, privateKey));
	}
	const pathOfFolder = (id: string | null) =>
		folderPath(id, folderMap).map((f) => sanitizeSegment(f.name)).join('/');

	const taken = new Set<string>();
	const zip = new ZipWriter(sink, { forceZip64: opts.zip64ForTesting });
	const failed: ExportResult['failed'] = [];
	let exported = 0;

	try {
		// Preserve empty folders too.
		const dirPaths = [...folderMap.keys()].map(pathOfFolder).filter(Boolean).sort();
		for (const dir of dirPaths) await zip.addDirectory(dir);

		for (let i = 0; i < files.length; i++) {
			signal?.throwIfAborted();
			const record = files[i];
			const fileKey = await unwrapRecordFileKey(record, privateKey);
			const meta = await decryptRecordMetadata(record, fileKey);
			const name = sanitizeSegment(meta?.name ?? `file-${record.id}`);
			const dir = meta?.folderId && folderMap.has(meta.folderId) ? pathOfFolder(meta.folderId) : '';
			const path = uniquePath(dir ? `${dir}/${name}` : name, taken);
			const size = meta?.size ?? 0;

			report({ phase: 'exporting', fileIndex: i + 1, currentName: path, percent: (i / files.length) * 100 });

			try {
				await zip.addFile(path, size, async (push) => {
					// The size recorded in metadata is what the ZIP entry declares, so
					// the decrypted byte count must match it exactly.
					let total = 0;
					const entrySink: PlaintextSink = {
						write: (chunk) => {
							total += chunk.length;
							return push(chunk);
						},
						commit: () => {
							if (total !== size) throw new Error(`Decrypted ${total} bytes but expected ${size}`);
						},
						abort: () => {}
					};
					await decryptFileToSink(record, fileKey, entrySink, { fetchChunk: opts.fetchChunkFor?.(record.id) });
				});
				exported++;
			} catch (err) {
				if (signal?.aborted) throw err;
				failed.push({ path, reason: err instanceof Error ? err.message : 'Unknown error' });
			}
		}

		if (failed.length > 0) {
			const text = new TextEncoder().encode(
				[
					'Some files could not be exported cleanly.',
					'Their entries in this archive may be missing or incomplete — re-download them from the vault.',
					'',
					...failed.map((f) => `- ${f.path}\n    ${f.reason}`)
				].join('\n')
			);
			await zip.addFile('EXPORT-REPORT.txt', text.length, (push) => push(text));
		}

		report({ phase: 'finalizing', fileIndex: files.length, percent: 99 });
		await zip.finish();
		await sink.commit();
	} catch (err) {
		await sink.abort();
		throw err;
	}

	report({ phase: 'done', fileIndex: files.length, percent: 100 });
	return { exported, failed };
}
