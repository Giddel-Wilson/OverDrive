export interface TestDropEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	sourceFile?: File;
	file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
	createReader?: () => { readEntries: (success: (entries: TestDropEntry[]) => void, failure: (error: unknown) => void) => void };
}

export function droppedFile(file: File): TestDropEntry {
	return { name: file.name, isFile: true, isDirectory: false, sourceFile: file, file: (success) => queueMicrotask(() => success(file)) };
}

export function droppedDirectory(name: string, children: TestDropEntry[], batchSize = 100): TestDropEntry {
	return {
		name, isFile: false, isDirectory: true,
		createReader: () => {
			let cursor = 0;
			return { readEntries: (success) => {
				const batch = children.slice(cursor, cursor + batchSize);
				cursor += batchSize;
				queueMicrotask(() => success(batch));
			} };
		}
	};
}

export function entryTransfer(entries: TestDropEntry[]): DataTransfer {
	return {
		types: ['Files'], files: entries.flatMap((entry) => entry.sourceFile ? [entry.sourceFile] : []),
		items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => entry.sourceFile ?? null })),
		dropEffect: 'none'
	} as unknown as DataTransfer;
}
