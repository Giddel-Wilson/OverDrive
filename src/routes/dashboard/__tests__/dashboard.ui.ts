/**
 * Mounts the real Vault page in jsdom, with real crypto and a stubbed network,
 * and drives it like a user: selecting, shift-click ranges, bulk trash with
 * Undo, bulk move, drag-and-drop, select-all and keyboard shortcuts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://app.test/dashboard') } }));

import Page from '../+page.svelte';
import { keyStore } from '$lib/stores/key-store.svelte';
import { generateEcdhKeypair } from '$crypto/key-encryption';
import { encryptAndUploadFile } from '$crypto/upload-pipeline';
import { createFolderPayload } from '$crypto/vault';
import { installFakeServer } from '$crypto/__tests__/fake-server';

interface Call { method: string; url: string; body: any }

async function setup() {
	const kp = await generateEcdhKeypair();
	keyStore.set({ privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyJwk: await crypto.subtle.exportKey('jwk', kp.publicKey), keyAlgo: 'ECDH-P256' });

	// Real encrypted records, produced by the real upload pipeline against an in-memory server.
	const server = installFakeServer();
	const upload = async (name: string, folderId: string | null) => {
		const { fileId } = await encryptAndUploadFile({ file: new File([`contents of ${name}`], name, { type: 'text/plain' }), recipientPublicKey: kp.publicKey, choice: { fileAlgo: 'AES-GCM', keyAlgo: 'ECDH-P256' }, folderId });
		return { ...server.record(fileId), createdAt: '2026-11-01T00:00:00Z' };
	};
	const folder = async (id: string, name: string, parentId: string | null) => ({ id, createdAt: '2026-11-01T00:00:00Z', ...(await createFolderPayload(name, parentId, 'ECDH-P256', kp.publicKey)) });

	const docs = await folder('folder-docs', 'Docs', null);
	const photos = await folder('folder-photos', 'Photos', null);
	const files = [await upload('alpha.txt', null), await upload('bravo.txt', null), await upload('charlie.txt', null), await upload('inside-docs.txt', 'folder-docs')];

	// Now swap in the app's own API, recording every mutation.
	const calls: Call[] = [];
	vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		if (method !== 'GET') calls.push({ method, url, body });
		const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (url.startsWith('/api/files?view=pending')) return ok({ files: [] });
		if (url.startsWith('/api/files?view=trash')) return ok({ files: [] });
		if (url.startsWith('/api/folders?view=trash')) return ok({ folders: [] });
		if (url === '/api/files') return ok({ files });
		if (url === '/api/folders') return ok({ folders: [docs, photos] });
		if (url === '/api/storage') return ok({ usedBytes: 1000, trashBytes: 0, fileCount: 4, quotaBytes: 5000 });
		return ok({ ok: true });
	}));
	return { files, calls, docs, photos };
}

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const rows = () => [...document.querySelectorAll<HTMLLIElement>('main ul > li')];
const rowByName = (name: string) => rows().find((li) => li.textContent?.includes(name))!;
const checkboxOf = (name: string) => $<HTMLInputElement>('input[type="checkbox"]', rowByName(name))!;
const buttonByText = (text: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)!;

async function settle() {
	await vi.waitFor(() => {
		for (const name of ['Docs', 'Photos', 'alpha.txt', 'bravo.txt', 'charlie.txt']) expect(rows().some((r) => r.textContent?.includes(name))).toBe(true);
	}, { timeout: 20_000 });
	await tick();
}

function drag(type: string, el: Element) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' } });
	el.dispatchEvent(ev);
	return ev;
}

/** Generous: these run under CPU contention in CI and next to other test runs. */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 15_000, interval: 20 });

let app: ReturnType<typeof mount> | null = null;
beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	vi.unstubAllGlobals();
	keyStore.lock();
});

async function render() {
	const env = await setup();
	app = mount(Page, { target: document.body, props: { data: { files: env.files, folders: [env.docs, env.photos], pending: [] } as never } });
	await settle();
	return env;
}

describe('Vault page', () => {
	it('shows a listing error instead of an empty vault and reloads the files on retry', async () => {
		const env = await setup();
		app = mount(Page, { target: document.body, props: { data: { files: [], folders: [], pending: [], listingError: 'File listing unavailable' } as never } });
		await waitFor(() => expect(document.body.textContent).toContain('File listing unavailable'));
		expect(document.body.textContent).not.toContain('No files yet');
		buttonByText('Retry loading files').click();
		await settle();
		expect(document.body.textContent).not.toContain('File listing unavailable');
	});
	it('decrypts and lists folders and files, folders first, in the current folder only', async () => {
		await render();
		const names = rows().map((r) => r.querySelector('p, button')?.textContent?.trim());
		expect(names.slice(0, 2)).toEqual(['Docs', 'Photos']);
		expect(names.slice(2)).toEqual(['alpha.txt', 'bravo.txt', 'charlie.txt']);
		expect(document.body.textContent).not.toContain('inside-docs.txt');
	});

	it('selecting shows the bar; shift-click selects a range; Escape clears', async () => {
		await render();
		expect($('[role="toolbar"]')).toBeNull();

		checkboxOf('alpha.txt').click();
		await tick();
		expect($('[role="toolbar"]')?.textContent).toContain('1 selected');

		checkboxOf('charlie.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
		await tick();
		expect($('[role="toolbar"]')?.textContent).toContain('3 selected'); // alpha..charlie

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await tick();
		await waitFor(() => expect($('[role="toolbar"]')).toBeNull()); // the bar fades out first
	});

	it('Ctrl+A selects everything visible', async () => {
		await render();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true }));
		await tick();
		expect($('[role="toolbar"]')?.textContent).toContain('5 selected'); // 2 folders + 3 files
	});

	it('bulk trash sends the whole subtree in ONE request, and Undo restores exactly that set', async () => {
		const { calls } = await render();
		checkboxOf('alpha.txt').click();
		checkboxOf('Docs').click(); // a folder: its file must travel with it
		await tick();
		buttonByText('Trash', $('[role="toolbar"]')!).click();
		await waitFor(() => expect(calls.some((c) => c.url === '/api/trash')).toBe(true));

		const trash = calls.find((c) => c.url === '/api/trash')!;
		expect(trash.body.action).toBe('trash');
		expect(trash.body.folderIds).toEqual(['folder-docs']);
		expect(trash.body.fileIds).toHaveLength(2); // alpha.txt + inside-docs.txt
		await waitFor(() => expect(document.body.textContent).toContain('2 items moved to trash'));
		await waitFor(() => expect($('[role="toolbar"]')).toBeNull()); // selection cleared

		buttonByText('Undo').click();
		await waitFor(() => expect(calls.filter((c) => c.url === '/api/trash')).toHaveLength(2));
		const undo = calls.filter((c) => c.url === '/api/trash')[1];
		expect(undo.body).toMatchObject({ action: 'restore', folderIds: ['folder-docs'] });
		expect([...undo.body.fileIds].sort()).toEqual([...trash.body.fileIds].sort());
	});

	it('bulk move: pick files, choose a folder in the dialog, every file is re-encrypted and PATCHed', async () => {
		const { calls, files } = await render();
		checkboxOf('alpha.txt').click();
		checkboxOf('bravo.txt').click();
		await tick();
		buttonByText('Move', $('[role="toolbar"]')!).click();
		await tick();

		const dialog = $('[role="dialog"]')!;
		expect(dialog.textContent).toContain('Move 2 items');
		buttonByText('Photos', dialog).click();
		await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));

		const patched = calls.filter((c) => c.method === 'PATCH').map((c) => c.url).sort();
		expect(patched).toEqual([`/api/files/${files[0].id}`, `/api/files/${files[1].id}`].sort());
		for (const c of calls.filter((x) => x.method === 'PATCH')) expect(c.body.encryptedBlob).toBeTruthy(); // ciphertext, never a name
		await waitFor(() => expect(document.body.textContent).toContain('Moved 2 items to Photos'));
		// They left the root list.
		expect(rows().some((r) => r.textContent?.includes('alpha.txt'))).toBe(false);
	});

	it('drag a file onto a folder moves it; dragging a SELECTED item moves the whole selection', async () => {
		const { calls, files } = await render();

		// single drag
		const alpha = rowByName('alpha.txt');
		drag('dragstart', alpha);
		const over = drag('dragover', rowByName('Docs'));
		expect(over.defaultPrevented).toBe(true); // a valid drop target
		drag('drop', rowByName('Docs'));
		await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
		expect(calls[0].url).toBe(`/api/files/${files[0].id}`);
		await waitFor(() => expect(rows().some((r) => r.textContent?.includes('alpha.txt'))).toBe(false));

		// multi drag: select bravo + charlie, drag one of them
		checkboxOf('bravo.txt').click();
		checkboxOf('charlie.txt').click();
		await tick();
		drag('dragstart', rowByName('bravo.txt'));
		drag('dragover', rowByName('Photos'));
		drag('drop', rowByName('Photos'));
		await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3));
		expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.url).slice(1).sort()).toEqual([`/api/files/${files[1].id}`, `/api/files/${files[2].id}`].sort());
	});

	it("refuses drops that make no sense: onto a file, or a folder onto itself", async () => {
		const { calls } = await render();
		drag('dragstart', rowByName('Docs'));
		expect(drag('dragover', rowByName('Docs')).defaultPrevented).toBe(false); // into itself
		expect(drag('dragover', rowByName('bravo.txt')).defaultPrevented).toBe(false); // files aren't targets
		drag('drop', rowByName('Docs'));
		await tick();
		expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
	});

	it('the Select button turns on selection mode, and rows then toggle on click', async () => {
		await render();
		buttonByText('Select').click();
		await tick();
		expect(buttonByText('Done')).toBeTruthy();
		rowByName('bravo.txt').click(); // click the row itself, not a button
		await tick();
		expect($('[role="toolbar"]')?.textContent).toContain('1 selected');
		buttonByText('Done').click();
		await waitFor(() => expect($('[role="toolbar"]')).toBeNull());
	});
});
