export interface UploadFileEntry {
	file: File;
	folderId: string | null;
	relativePath?: string;
}

export interface UploadBatchResult {
	uploaded: number;
	cancelled: number;
	failed: boolean;
}

export interface DroppedTree {
	files: { file: File; directoryPath: string[] }[];
	directories: string[][];
}

interface DroppedEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
	createReader?: () => { readEntries: (success: (entries: DroppedEntry[]) => void, failure: (error: unknown) => void) => void };
}

interface DroppedHandle {
	name: string;
	kind: 'file' | 'directory';
	getFile?: () => Promise<File>;
	values?: () => AsyncIterable<DroppedHandle>;
}

interface DroppedItem {
	kind: string;
	getAsFile?: () => File | null;
	webkitGetAsEntry?: () => DroppedEntry | null;
	getAsFileSystemHandle?: () => Promise<DroppedHandle | null>;
}

type HandleResult = { handle: DroppedHandle | null } | { error: unknown };
interface DroppedRoot {
	entry?: DroppedEntry;
	file?: File;
	handle?: Promise<HandleResult>;
}

export function isExternalFileDrag(data: DataTransfer | null) {
	return !!data && (Array.from(data.types ?? []).includes('Files')
		|| Array.from(data.items ?? []).some((item) => item.kind === 'file')
		|| data.files?.length > 0);
}

/** Capture entries/handle promises before awaiting: browsers protect the transfer after drop. */
export async function readDroppedTree(data: DataTransfer): Promise<DroppedTree> {
	const roots: DroppedRoot[] = [];
	const fallbackFiles = Array.from(data.files ?? []);
	let fileIndex = 0;
	for (const item of Array.from(data.items ?? []) as unknown as DroppedItem[]) {
		if (item.kind !== 'file') continue;
		const fallback = fallbackFiles[fileIndex++];
		const entry = item.webkitGetAsEntry?.();
		if (entry) { roots.push({ entry }); continue; }
		const handle = item.getAsFileSystemHandle?.();
		if (handle) {
			roots.push({ handle: handle.then((value) => ({ handle: value }), (error) => ({ error })) });
			continue;
		}
		const file = item.getAsFile?.() ?? fallback;
		if (!file) throw new Error('This browser could not read a dropped file or folder. Try dropping it again.');
		roots.push({ file });
	}
	if (!roots.length) roots.push(...fallbackFiles.map((file) => ({ file })));

	const files: DroppedTree['files'] = [];
	const directories = new Map<string, string[]>();
	const validate = (parts: string[]) => {
		if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('/'))) throw new Error('The dropped folder contains an invalid path.');
	};
	function addDirectory(parts: string[]) {
		validate(parts);
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i);
			directories.set(JSON.stringify(path), path);
		}
	}
	function addFile(file: File, directoryPath: string[]) {
		addDirectory(directoryPath);
		files.push({ file, directoryPath: [...directoryPath] });
	}
	function addLooseFile(file: File) {
		const path = file.webkitRelativePath?.split('/').filter(Boolean) ?? [];
		addFile(file, path.slice(0, -1));
	}
	async function walkEntry(entry: DroppedEntry, parent: string[]) {
		validate([entry.name]);
		if (entry.isFile && entry.file) {
			const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
			if (parent.length) addFile(file, parent); else addLooseFile(file);
			return;
		}
		if (!entry.isDirectory || !entry.createReader) throw new Error('This browser could not read the dropped folder.');
		const path = [...parent, entry.name];
		addDirectory(path);
		const reader = entry.createReader();
		// Chromium returns directory entries in batches of up to 100.
		while (true) {
			const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (!batch.length) break;
			for (const child of batch) await walkEntry(child, path);
		}
	}
	async function walkHandle(handle: DroppedHandle, parent: string[]) {
		validate([handle.name]);
		if (handle.kind === 'file' && handle.getFile) {
			const file = await handle.getFile();
			if (parent.length) addFile(file, parent); else addLooseFile(file);
			return;
		}
		if (handle.kind !== 'directory' || !handle.values) throw new Error('This browser could not read the dropped folder.');
		const path = [...parent, handle.name];
		addDirectory(path);
		for await (const child of handle.values()) await walkHandle(child, path);
	}
	for (const root of roots) {
		if (root.entry) await walkEntry(root.entry, []);
		else if (root.handle) {
			const result = await root.handle;
			if ('error' in result) throw result.error;
			if (!result.handle) throw new Error('Could not read a dropped file or folder. Try dropping it again.');
			await walkHandle(result.handle, []);
		}
		else if (root.file) addLooseFile(root.file);
	}
	if (!files.length && !directories.size) throw new Error('Could not read the dropped files. Try dropping them again.');
	return { files, directories: [...directories.values()].sort((a, b) => a.length - b.length) };
}
