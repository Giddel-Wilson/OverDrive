import { describe, expect, it } from 'vitest';
import { readDroppedTree } from '../file-drop';
import { droppedDirectory, droppedFile, entryTransfer } from './file-drop-fixtures';

describe('external directory drops', () => {
	it('reads every directory batch and preserves nested and empty folders', async () => {
		const root = droppedDirectory('Pictures', [
			...Array.from({ length: 101 }, (_, i) => droppedFile(new File(['file'], `photo-${i}.txt`))),
			droppedDirectory('Nested', [droppedFile(new File(['nested'], 'notes.txt'))]),
			droppedDirectory('Empty', [])
		]);
		const tree = await readDroppedTree(entryTransfer([root]));
		expect(tree.files).toHaveLength(102);
		expect(tree.directories).toEqual([['Pictures'], ['Pictures', 'Nested'], ['Pictures', 'Empty']]);
		expect(tree.files.find((entry) => entry.file.name === 'notes.txt')?.directoryPath).toEqual(['Pictures', 'Nested']);
	});

	it('captures all root entries before the browser closes access to the transfer', async () => {
		let readable = true;
		const entries = [droppedDirectory('Folder', [droppedFile(new File(['one'], 'one.txt'))]), droppedFile(new File(['two'], 'two.txt'))];
		const data = {
			files: [], items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => { if (!readable) throw new Error('Transfer is protected'); return entry; } }))
		} as unknown as DataTransfer;
		const pending = readDroppedTree(data);
		readable = false;
		const tree = await pending;
		expect(tree.files.map((entry) => [entry.file.name, entry.directoryPath])).toEqual([['one.txt', ['Folder']], ['two.txt', []]]);
	});

	it('supports directory handles when legacy entries are unavailable', async () => {
		const root = {
			name: 'Documents', kind: 'directory',
			async *values() {
				yield { name: 'readme.txt', kind: 'file', getFile: async () => new File(['readme'], 'readme.txt') };
				yield { name: 'Empty', kind: 'directory', async *values() {} };
			}
		};
		const tree = await readDroppedTree({ files: [], items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(root) }] } as unknown as DataTransfer);
		expect(tree.files[0].directoryPath).toEqual(['Documents']);
		expect(tree.directories).toEqual([['Documents'], ['Documents', 'Empty']]);
	});

	it('preserves relative paths supplied with a FileList fallback', async () => {
		const file = new File(['notes'], 'notes.txt');
		Object.defineProperty(file, 'webkitRelativePath', { value: 'Archive/Work/notes.txt' });
		const tree = await readDroppedTree({ files: [file], items: [] } as unknown as DataTransfer);
		expect(tree.files[0].directoryPath).toEqual(['Archive', 'Work']);
		expect(tree.directories).toEqual([['Archive'], ['Archive', 'Work']]);
		expect(await readDroppedTree(entryTransfer([droppedFile(file)]))).toEqual(tree);
		expect(await readDroppedTree({ files: [], items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve({ name: file.name, kind: 'file', getFile: async () => file }) }] } as unknown as DataTransfer)).toEqual(tree);
	});

	it('rejects unreadable entries and missing handles instead of silently returning a partial import', async () => {
		const broken = droppedDirectory('Broken', []);
		broken.createReader = () => ({ readEntries: (_success, failure) => failure(new Error('Folder could not be read')) });
		await expect(readDroppedTree(entryTransfer([droppedFile(new File(['good'], 'good.txt')), broken]))).rejects.toThrow('Folder could not be read');
		await expect(readDroppedTree({ files: [], items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(null) }] } as unknown as DataTransfer)).rejects.toThrow('Could not read');
	});

	it('rejects paths that would escape the selected destination', async () => {
		const file = new File(['contents'], 'outside.txt');
		Object.defineProperty(file, 'webkitRelativePath', { value: '../outside.txt' });
		await expect(readDroppedTree({ files: [file], items: [] } as unknown as DataTransfer)).rejects.toThrow('invalid path');
	});
});
