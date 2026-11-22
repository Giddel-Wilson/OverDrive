/** The shared bottom sheet, the ⋮ row menu and the header's mobile menu, mounted in jsdom. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import { Download, Trash2 } from 'lucide-svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://app.test/settings/account') } }));

import RowMenu from '../RowMenu.svelte';
import AppHeader from '../AppHeader.svelte';

/** Generous: these run under CPU contention in CI and next to other test runs. */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 15_000, interval: 20 });

let app: ReturnType<typeof mount> | null = null;
afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	document.body.innerHTML = '';
	document.body.style.overflow = '';
	vi.unstubAllGlobals();
});

const dialog = () => document.querySelector('[role="dialog"]');
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

describe('RowMenu (⋮ bottom sheet)', () => {
	it('opens a sheet with the actions, runs one and closes; Esc and the backdrop also close it', async () => {
		const onDownload = vi.fn();
		const onTrash = vi.fn();
		app = mount(RowMenu, {
			target: document.body,
			props: {
				title: 'report.pdf',
				actions: [
					{ label: 'Download', icon: Download, onclick: onDownload },
					{ label: 'Move to trash', icon: Trash2, onclick: onTrash, danger: true }
				]
			}
		});
		expect(dialog()).toBeNull();

		byLabel('Actions for report.pdf').click();
		await tick();
		expect(dialog()?.textContent).toContain('report.pdf');
		expect(dialog()?.textContent).toContain('Download');
		expect(document.body.style.overflow).toBe('hidden'); // page behind is frozen

		[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Download')!.click();
		expect(onDownload).toHaveBeenCalledOnce();
		await waitFor(() => expect(dialog()).toBeNull());
		expect(document.body.style.overflow).toBe(''); // and released

		byLabel('Actions for report.pdf').click();
		await tick();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await waitFor(() => expect(dialog()).toBeNull());

		byLabel('Actions for report.pdf').click();
		await tick();
		byLabel('Close').click(); // backdrop
		await waitFor(() => expect(dialog()).toBeNull());
		expect(onTrash).not.toHaveBeenCalled();
	});

	it("doesn't run a disabled action", async () => {
		const run = vi.fn();
		app = mount(RowMenu, { target: document.body, props: { title: 'x', actions: [{ label: 'Download', icon: Download, onclick: run, disabled: true }] } });
		byLabel('Actions for x').click();
		await tick();
		const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Download')!;
		expect(btn.disabled).toBe(true);
		btn.click();
		expect(run).not.toHaveBeenCalled();
	});
});

describe('AppHeader', () => {
	const stubMe = (isAdmin: boolean) =>
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'a@b.c', isAdmin }), { status: 200 })));

	it('shows the Admin link only to admins', async () => {
		stubMe(false);
		app = mount(AppHeader, { target: document.body });
		await new Promise((r) => setTimeout(r, 20));
		expect(document.querySelector('header nav')?.textContent).not.toContain('Admin');
		await unmount(app);
		document.body.innerHTML = '';

		stubMe(true);
		app = mount(AppHeader, { target: document.body });
		await waitFor(() => expect(document.querySelector('header nav')?.textContent).toContain('Admin'));
	});

	it('the mobile menu is the same bottom sheet: links, current page highlighted, sign out', async () => {
		stubMe(true);
		app = mount(AppHeader, { target: document.body });
		await tick();
		byLabel('Open menu').click();
		await tick();

		const sheet = dialog()!;
		expect(sheet.getAttribute('aria-label')).toBe('Menu');
		for (const label of ['Vault', 'Access logs', 'Keys', 'Account', 'Sign out']) expect(sheet.textContent).toContain(label);
		const current = sheet.querySelector('a[aria-current="page"]');
		expect(current?.textContent?.trim()).toBe('Account'); // we're on /settings/account

		sheet.querySelector<HTMLAnchorElement>('a[href="/dashboard"]')!.click();
		await waitFor(() => expect(dialog()).toBeNull()); // tapping a link closes it
	});
});
