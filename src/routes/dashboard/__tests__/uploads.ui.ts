/** Drives the actual upload UI and crypto against an in-memory versioned file store. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';

const { mockPage } = vi.hoisted(() => ({ mockPage: { url: new URL('http://app.test/dashboard') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/state', () => ({ page: mockPage }));

import Page from '../+page.svelte';
import { keyStore } from '$lib/stores/key-store.svelte';
import { generateEcdhKeypair } from '$crypto/key-encryption';
import { encryptAndUploadFile } from '$crypto/upload-pipeline';
import { downloadAndDecryptFile, unwrapRecordFileKey, decryptRecordMetadata, type EncryptedFileRecord } from '$crypto/download-pipeline';
import { createFolderPayload, decryptFolderMeta, type FolderRecord } from '$crypto/vault';
import { installFakeServer } from '$crypto/__tests__/fake-server';
import { droppedDirectory, droppedFile, entryTransfer } from '$lib/__tests__/file-drop-fixtures';
import * as autoEncryption from '$crypto/auto-encryption';

let app: ReturnType<typeof mount> | null = null;
afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	document.body.innerHTML = '';
	document.body.style.overflow = '';
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	keyStore.lock();
	mockPage.url = new URL('http://app.test/dashboard');
});

const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 15_000, interval: 20 });
const button = (text: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === text)!;

async function render(inDocs = false, openUploader = true) {
	if (inDocs) mockPage.url = new URL('http://app.test/dashboard?f=folder-docs');
	const pair = await generateEcdhKeypair();
	keyStore.set({ privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey), keyAlgo: 'ECDH-P256' });
	const server = installFakeServer();
	const upload = async (name: string, folderId: string | null) => encryptAndUploadFile({
		file: new File([`Original ${name}`], name, { type: 'text/plain' }), recipientPublicKey: pair.publicKey,
		choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' }, folderId
	});
	const existing = await upload('notes.txt', null);
	const inside = await upload('inside-docs.txt', 'folder-docs');
	const docs = { id: 'folder-docs', ...(await createFolderPayload('Docs', null, 'ECDH-P256', pair.publicKey)) };
	const folders = new Map<string, FolderRecord>([[docs.id, docs]]);
	const folderWrites: Record<string, unknown>[] = [];
	let nextFolder = 1;
	const storageFetch = globalThis.fetch;
	const mutations: { action?: string; replacesFileId?: string; baseVersion?: number }[] = [];
	let listingUnavailable = false;
	let folderListingUnavailable = false;
	const active = () => [...server.files].filter(([, entry]) => entry.complete).map(([id]) => server.record(id));
	const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
	vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === '/api/files') return listingUnavailable ? json({ message: 'Listing unavailable' }, 503) : json({ files: active() });
		if (url === '/api/files?view=pending') return json({ files: [] });
		if (url === '/api/folders') {
			if (init?.method === 'POST') {
				const payload = JSON.parse(init.body as string);
				const id = `imported-folder-${nextFolder++}`;
				folders.set(id, { id, ...payload });
				folderWrites.push(payload);
				return json({ id });
			}
			return folderListingUnavailable ? json({ message: 'Folder listing unavailable' }, 503) : json({ folders: [...folders.values()] });
		}
		if (url === '/api/storage') return json({ usedBytes: 500, trashBytes: 0, fileCount: active().length, quotaBytes: 1000000 });
		if (url === '/api/auth/me') return json({ isAdmin: false });
		if (url.endsWith('/versions') && (!init?.method || init.method === 'GET')) return json({ versions: [], retainedVersions: 5 });
		if (url === '/api/files/upload' && init?.method === 'POST') mutations.push(JSON.parse(init.body as string));
		return storageFetch(input, init);
	}));
	app = mount(Page, { target: document.body, props: { data: { files: active(), folders: [docs], pending: [], listingError: null } as never } });
	await waitFor(() => expect(document.querySelector('main')?.textContent).toContain(inDocs ? 'inside-docs.txt' : 'notes.txt'));
	if (openUploader) { button('New file').click(); await tick(); }
	return { server, pair, existing, inside, mutations, folders, folderWrites, failListing: () => { listingUnavailable = true; }, failFolderListing: () => { folderListingUnavailable = true; } };
}

function selectFiles(files: File[]) {
	const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"][multiple]')!;
	Object.defineProperty(input, 'files', { configurable: true, value: files });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function contents(record: EncryptedFileRecord, privateKey: CryptoKey) {
	return (await downloadAndDecryptFile(record, await unwrapRecordFileKey(record, privateKey))).blob.text();
}

function externalEvent(type: string, dataTransfer: DataTransfer, target: EventTarget = document.querySelector('main')!) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, { dataTransfer });
	target.dispatchEvent(event);
	return event;
}

async function folderMetadata(folders: Map<string, FolderRecord>, privateKey: CryptoKey) {
	return Promise.all([...folders.values()].map(async (record) => ({ id: record.id, ...(await decryptFolderMeta(record, privateKey)) })));
}

describe('duplicate-file uploads', () => {
	it.each(['file picker', 'drag-and-drop'])('uploads every selected file through %s', async (method) => {
		const { server, mutations, pair } = await render();
		const selected = [
			new File(['First contents'], 'first.txt', { type: 'text/plain' }),
			new File(['Second contents'], 'second.txt', { type: 'text/plain' })
		];
		if (method === 'file picker') {
			expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]')?.multiple).toBe(true);
			selectFiles(selected);
		} else {
			const dropZone = document.querySelector('[role="dialog"] button[aria-label^="Drag and drop files"]')!;
			const event = new Event('drop', { bubbles: true, cancelable: true });
			Object.assign(event, { dataTransfer: { files: selected } });
			dropZone.dispatchEvent(event);
		}
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2 files encrypted and uploaded.'));
		expect(server.files.size).toBe(4);
		expect(mutations.filter((entry) => entry.action === 'init')).toHaveLength(2);
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		const added = [...server.files.keys()].slice(-2).map((id) => server.record(id));
		expect(await Promise.all(added.map((record) => contents(record, pair.privateKey)))).toEqual(['First contents', 'Second contents']);
	});

	it('asks before sending any upload, and Cancel leaves the current file untouched', async () => {
		const { server, mutations, existing } = await render();
		const before = server.record(existing.fileId);
		selectFiles([new File(['Replacement'], 'notes.txt', { type: 'text/plain' })]);
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Continuing will overwrite the current file in your vault'));
		expect(mutations).toHaveLength(0);
		button('Cancel', document.querySelector('[role="alertdialog"]')!).click();
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
		expect(mutations).toHaveLength(0);
		expect(server.files.size).toBe(2);
		expect(server.record(existing.fileId)).toEqual(before);
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypt & upload');
		expect(document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
	});

	it('Continue overwrites the same logical file and keeps the old encrypted content recoverable', async () => {
		const { server, mutations, existing, pair } = await render();
		const original = server.record(existing.fileId);
		// Some browsers supply no MIME hint for an otherwise identical filename and extension.
		selectFiles([new File(['Updated contents'], 'notes.txt')]);
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
		button('Continue', document.querySelector('[role="alertdialog"]')!).click();
		await waitFor(() => expect(server.record(existing.fileId).versionNumber).toBe(2));
		expect(server.files.size).toBe(2);
		expect(mutations.find((entry) => entry.action === 'init')).toMatchObject({ replacesFileId: existing.fileId, baseVersion: 1 });
		expect(server.record(existing.fileId).fileIv).not.toBe(original.fileIv);
		expect(await contents(server.record(existing.fileId), pair.privateKey)).toBe('Updated contents');
		expect(await contents(server.versionRecord(existing.fileId, 1), pair.privateKey)).toBe('Original notes.txt');
	});

	it.each([
		{ inDocs: true, name: 'notes.txt', type: 'text/plain', folderId: 'folder-docs' },
		{ inDocs: false, name: 'notes.pdf', type: 'application/pdf', folderId: null }
	])('allows $name in folder $folderId without an overwrite prompt', async ({ inDocs, name, type, folderId }) => {
		const { server, mutations, pair } = await render(inDocs);
		selectFiles([new File(['Separate file'], name, { type })]);
		await waitFor(() => expect([...server.files.values()].filter((entry) => entry.complete)).toHaveLength(3));
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(mutations.find((entry) => entry.action === 'init')?.replacesFileId).toBeUndefined();
		const added = server.record([...server.files.keys()].at(-1)!);
		expect(await decryptRecordMetadata(added, await unwrapRecordFileKey(added, pair.privateKey))).toMatchObject({ name, folderId });
	});

	it('refreshes between batch entries so the second identical filename prompts and becomes a version', async () => {
		const { server, mutations, pair } = await render();
		selectFiles([
			new File(['First batch contents'], 'batch.txt', { type: 'text/plain' }),
			new File(['Second batch contents'], 'batch.txt', { type: 'text/plain' })
		]);
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('batch.txt'));
		expect(mutations.filter((entry) => entry.action === 'init')).toHaveLength(1);
		const addedId = [...server.files.keys()].at(-1)!;
		button('Continue', document.querySelector('[role="alertdialog"]')!).click();
		await waitFor(() => expect(server.record(addedId).versionNumber).toBe(2));
		expect(server.files.size).toBe(3);
		expect(await contents(server.record(addedId), pair.privateKey)).toBe('Second batch contents');
		expect(await contents(server.versionRecord(addedId, 1), pair.privateKey)).toBe('First batch contents');
	});

	it('does not create an unchecked duplicate when refreshing the file list fails', async () => {
		const { server, mutations, failListing } = await render();
		failListing();
		selectFiles([new File(['New contents'], 'new.txt', { type: 'text/plain' })]);
		await waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Could not check existing files'));
		expect(mutations).toHaveLength(0);
		expect(server.files.size).toBe(2);
	});

	it('keeps a new overwrite confirmation open when an earlier upload auto-close timer fires', async () => {
		const { server, existing, mutations } = await render();
		selectFiles([new File(['First upload'], 'new.txt', { type: 'text/plain' })]);
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypted and uploaded successfully.'));
		selectFiles([new File(['Replacement'], 'notes.txt', { type: 'text/plain' })]);
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('notes.txt');
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		button('Cancel', document.querySelector('[role="alertdialog"]')!).click();
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
		expect(server.record(existing.fileId).versionNumber).toBe(1);
		expect(mutations.filter((entry) => entry.action === 'init')).toHaveLength(1);
	});
});

describe('external imports into the open vault folder', () => {
	it('opens on drag-enter, encrypts after drop, and closes after upload', async () => {
		const choice = vi.spyOn(autoEncryption, 'chooseAutoEncryption').mockResolvedValue('ChaCha20-Poly1305');
		const { server, pair, mutations } = await render(true, false);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		const data = { types: ['Files'], files: [new File(['One'], 'one.txt'), new File(['Two'], 'two.txt')], items: [], dropEffect: 'none' } as unknown as DataTransfer;
		externalEvent('dragenter', data);
		await tick();
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypt & upload');
		expect(document.querySelector('[role="dialog"]')?.parentElement?.classList.contains('pointer-events-none')).toBe(true);
		expect(choice).not.toHaveBeenCalled();
		expect(mutations).toHaveLength(0);
		expect(externalEvent('dragover', data).defaultPrevented).toBe(true);
		expect(data.dropEffect).toBe('copy');
		externalEvent('drop', data);
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2 files encrypted and uploaded.'));
		const added = [...server.files.keys()].slice(-2).map((id) => server.record(id));
		for (const record of added) {
			expect(record.fileAlgo).toBe('ChaCha20-Poly1305');
			expect(record.metadata?.algo).toBe(record.fileAlgo);
			expect(await decryptRecordMetadata(record, await unwrapRecordFileKey(record, pair.privateKey))).toMatchObject({ folderId: 'folder-docs' });
		}
		expect(await Promise.all(added.map((record) => contents(record, pair.privateKey)))).toEqual(['One', 'Two']);
		await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
	});

	it('preserves nested and empty directory structure with encrypted folder metadata', async () => {
		const { server, pair, folders, folderWrites } = await render(true, false);
		const root = droppedDirectory('Holiday Album', [
			droppedFile(new File(['Cover'], 'cover.txt', { type: 'text/plain' })),
			droppedDirectory('Nested', [droppedFile(new File(['Nested notes'], 'notes.txt', { type: 'text/plain' }))]),
			droppedDirectory('Empty', [])
		]);
		externalEvent('drop', entryTransfer([root]));
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2 files encrypted and uploaded.'));
		const metadata = await folderMetadata(folders, pair.privateKey);
		const album = metadata.find((entry) => entry.name === 'Holiday Album')!;
		const nested = metadata.find((entry) => entry.name === 'Nested')!;
		expect(album.parentId).toBe('folder-docs');
		expect(nested.parentId).toBe(album.id);
		expect(metadata.find((entry) => entry.name === 'Empty')?.parentId).toBe(album.id);
		expect(folderWrites).toHaveLength(3);
		expect(JSON.stringify(folderWrites)).not.toContain('Holiday Album');
		const added = [...server.files.keys()].slice(-2).map((id) => server.record(id));
		const fileMetadata = await Promise.all(added.map(async (record) => decryptRecordMetadata(record, await unwrapRecordFileKey(record, pair.privateKey))));
		expect(fileMetadata).toEqual([expect.objectContaining({ name: 'cover.txt', folderId: album.id }), expect.objectContaining({ name: 'notes.txt', folderId: nested.id })]);
		expect(await Promise.all(added.map((record) => contents(record, pair.privateKey)))).toEqual(['Cover', 'Nested notes']);
	});

	it('merges an existing folder and confirms an overwrite inside that folder', async () => {
		const { server, pair, inside, folders, folderWrites, mutations } = await render(false, false);
		externalEvent('drop', entryTransfer([droppedDirectory('Docs', [droppedFile(new File(['Updated document'], 'inside-docs.txt', { type: 'text/plain' }))])]));
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('inside-docs.txt'));
		expect(folderWrites).toHaveLength(0);
		expect(mutations).toHaveLength(0);
		button('Continue', document.querySelector('[role="alertdialog"]')!).click();
		await waitFor(() => expect(server.record(inside.fileId).versionNumber).toBe(2));
		expect(folders.size).toBe(1);
		expect(server.files.size).toBe(2);
		expect(await contents(server.record(inside.fileId), pair.privateKey)).toBe('Updated document');
		expect(await contents(server.versionRecord(inside.fileId, 1), pair.privateKey)).toBe('Original inside-docs.txt');
	});

	it('imports a completely empty directory tree without creating placeholder files', async () => {
		vi.spyOn(autoEncryption, 'chooseAutoEncryption').mockResolvedValue('ChaCha20-Poly1305');
		const { server, pair, folders, mutations } = await render(true, false);
		externalEvent('drop', entryTransfer([droppedDirectory('Empty Bundle', [droppedDirectory('Vacant', [])])]));
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Created 2 folders'));
		expect(server.files.size).toBe(2);
		expect(mutations).toHaveLength(0);
		const metadata = await folderMetadata(folders, pair.privateKey);
		const root = metadata.find((entry) => entry.name === 'Empty Bundle')!;
		expect(root.parentId).toBe('folder-docs');
		expect(metadata.find((entry) => entry.name === 'Vacant')?.parentId).toBe(root.id);
		expect([...folders.values()].filter((entry) => entry.id !== 'folder-docs').every((entry) => entry.algo === 'ChaCha20-Poly1305')).toBe(true);
		await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
	});

	it('queues a second external drop while the first is waiting for overwrite confirmation', async () => {
		const { server, existing, mutations, pair } = await render(false, false);
		externalEvent('drop', entryTransfer([droppedFile(new File(['Replacement'], 'notes.txt', { type: 'text/plain' }))]));
		await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
		externalEvent('drop', entryTransfer([droppedFile(new File(['Queued file'], 'after.txt', { type: 'text/plain' }))]));
		await tick();
		expect(mutations).toHaveLength(0);
		button('Cancel', document.querySelector('[role="alertdialog"]')!).click();
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypted and uploaded successfully.'));
		expect(server.record(existing.fileId).versionNumber).toBe(1);
		expect(server.files.size).toBe(3);
		expect(await contents(server.record([...server.files.keys()].at(-1)!), pair.privateKey)).toBe('Queued file');
	});

	it('reports directory-read failures before creating any folder or upload', async () => {
		const { server, folders, folderWrites, mutations } = await render(false, false);
		const broken = droppedDirectory('Broken', []);
		broken.createReader = () => ({ readEntries: (_success, failure) => failure(new Error('Folder could not be read')) });
		externalEvent('drop', entryTransfer([droppedFile(new File(['Readable'], 'good.txt')), broken]));
		await waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Folder could not be read'));
		expect(server.files.size).toBe(2);
		expect(folders.size).toBe(1);
		expect(folderWrites).toHaveLength(0);
		expect(mutations).toHaveLength(0);
	});

	it('opens an unlock prompt and keeps the drop unwritten when the key is locked', async () => {
		const { mutations, folderWrites } = await render(false, false);
		keyStore.lock();
		await tick();
		externalEvent('drop', entryTransfer([droppedFile(new File(['Private'], 'private.txt'))]));
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Unlock your key'));
		expect(mutations).toHaveLength(0);
		expect(folderWrites).toHaveLength(0);
	});

	it('does not create folders or uploads when the destination listing cannot be refreshed', async () => {
		const { server, folders, folderWrites, mutations, failFolderListing } = await render(false, false);
		failFolderListing();
		externalEvent('drop', entryTransfer([droppedDirectory('New Tree', [droppedFile(new File(['Private'], 'private.txt'))])]));
		await waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Could not load the destination folder'));
		expect(server.files.size).toBe(2);
		expect(folders.size).toBe(1);
		expect(folderWrites).toHaveLength(0);
		expect(mutations).toHaveLength(0);
	});

	it('keeps the upload card above an existing dialog and scrolling locked until both close', async () => {
		await render(false, false);
		(document.querySelector('[aria-label="Version history for notes.txt"]') as HTMLButtonElement).click();
		await tick();
		const history = document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Version history"]')!;
		externalEvent('drop', entryTransfer([droppedDirectory('Empty Import', [])]));
		await waitFor(() => expect(document.querySelector('[role="dialog"][aria-label="Encrypt & upload"]')?.textContent).toContain('Created 1 folder'));
		const upload = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Encrypt & upload"]')!;
		expect(upload.parentElement?.style.zIndex).toBe('60');
		(history.querySelector('[aria-label="Close"]') as HTMLButtonElement).click();
		await tick();
		expect(document.body.style.overflow).toBe('hidden');
		(upload.querySelector('[aria-label="Close"]') as HTMLButtonElement).click();
		await tick();
		expect(document.body.style.overflow).toBe('');
	});

	it.each([
		{ inDocs: false, selector: 'main li[data-upload-folder="folder-docs"]', folderId: 'folder-docs' },
		{ inDocs: true, selector: 'nav[aria-label="Folder path"] [data-upload-folder=""]', folderId: null }
	])('honours the folder/breadcrumb drop target $folderId', async ({ inDocs, selector, folderId }) => {
		const { server, pair } = await render(inDocs, false);
		const target = document.querySelector(selector)!;
		const data = entryTransfer([droppedFile(new File(['Chosen destination'], 'target.txt'))]);
		externalEvent('dragover', data, target);
		await tick();
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypt & upload');
		externalEvent('drop', data, target);
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypted and uploaded successfully.'));
		const added = server.record([...server.files.keys()].at(-1)!);
		expect(await decryptRecordMetadata(added, await unwrapRecordFileKey(added, pair.privateKey))).toMatchObject({ folderId });
	});

	it('uses automatic choice for an external drop even if the open card was on a manual cipher', async () => {
		const { server } = await render();
		button('AES-GCM').click();
		await tick();
		expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('AES-GCM');
		button('AES-GCM').click(); await tick();
		expect(document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
		button('ChaCha20-Poly1305').click(); await tick();
		expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('ChaCha20-Poly1305');
		button('ChaCha20-Poly1305').click(); await tick();
		expect(document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
		button('AES-GCM').click(); await tick();
		const choice = vi.spyOn(autoEncryption, 'chooseAutoEncryption').mockResolvedValue('ChaCha20-Poly1305');
		externalEvent('drop', entryTransfer([droppedFile(new File(['Automatic'], 'auto.txt'))]));
		await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Encrypted and uploaded successfully.'));
		expect(choice).toHaveBeenCalled();
		expect(server.record([...server.files.keys()].at(-1)!).fileAlgo).toBe('ChaCha20-Poly1305');
		expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('ChaCha20-Poly1305');
	});

	it.each(['dragleave', 'dragend', 'Escape'])('closes a drag-preview card on %s without sending an upload', async (reason) => {
		const { mutations, folderWrites } = await render(false, false);
		const data = entryTransfer([droppedFile(new File(['No drop'], 'not-dropped.txt'))]);
		externalEvent('dragenter', data);
		await tick();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		else externalEvent(reason, data);
		await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(mutations).toHaveLength(0);
		expect(folderWrites).toHaveLength(0);
	});

	it('closes when an external source ends the drag without a drop or final event', async () => {
		const { mutations } = await render(false, false);
		externalEvent('dragenter', entryTransfer([droppedFile(new File(['No drop'], 'abandoned.txt'))]));
		await tick();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(mutations).toHaveLength(0);
	});
});
