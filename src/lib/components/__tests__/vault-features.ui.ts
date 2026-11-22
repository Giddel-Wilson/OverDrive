import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import PhotoThumbnail from '../PhotoThumbnail.svelte';
import ShareLinksList from '../ShareLinksList.svelte';
import Dashboard from '../../../routes/dashboard/+page.svelte';
import { generateEcdhKeypair, wrapFileKey } from '$crypto/key-encryption';
import { generateFileKey, encryptBlob, newBaseNonce } from '$crypto/file-encryption';
import { encryptPhotoThumbnail } from '$crypto/thumbnails';
import { fromBase64, toBase64 } from '$crypto/encoding';
import { keyStore } from '$lib/stores/key-store.svelte';
import type { EncryptedFileRecord } from '$crypto/download-pipeline';
import type { ShareLinkRow } from '$lib/shared/shares';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://app.test/dashboard') } }));

let app: ReturnType<typeof mount> | null = null;
afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	keyStore.lock();
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function photoFixture() {
	const pair = await generateEcdhKeypair();
	const key = generateFileKey();
	const wrapped = await wrapFileKey(key, 'ECDH-P256', pair.publicKey);
	const encryptedMetadata = await encryptBlob(new TextEncoder().encode(JSON.stringify({ name: 'photo.png', mimeType: 'image/png', size: 8, folderId: null })), key, 'AES-GCM');
	const image = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], { type: 'image/png' });
	const thumbnail = await encryptPhotoThumbnail(image, key);
	const bytes = fromBase64(thumbnail.encryptedBlob);
	const record: EncryptedFileRecord = {
		id: 'photo-id', versionNumber: 1, fileAlgo: 'AES-GCM', fileIv: toBase64(newBaseNonce()), keyAlgo: 'ECDH-P256',
		wrappedFileKey: toBase64(wrapped.wrapped), keyWrapIv: toBase64(wrapped.iv!), keyWrapEphemeralPublicKeyJwk: wrapped.ephemeralPublicKeyJwk!,
		totalChunks: 1, ciphertextSha256: 'a'.repeat(64), ciphertextSizeBytes: 24, createdAt: '2026-11-01T00:00:00Z',
		metadata: { encryptedBlob: toBase64(encryptedMetadata.ciphertext), iv: toBase64(encryptedMetadata.iv), algo: 'AES-GCM' },
		thumbnail: { iv: thumbnail.iv, ciphertextSha256: thumbnail.ciphertextSha256, sizeBytes: bytes.length }
	};
	if (!URL.createObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:fixture' });
	if (!URL.revokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
	const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-thumbnail');
	const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	return { pair, key, record, bytes, image, createUrl, revokeUrl };
}

describe('photo gallery and link controls', () => {
	it('decrypts only the thumbnail and releases its object URL when the tile is removed', async () => {
		const fixture = await photoFixture();
		const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(Uint8Array.from(fixture.bytes).buffer));
		vi.stubGlobal('fetch', fetcher);
		app = mount(PhotoThumbnail, { target: document.body, props: { record: fixture.record, privateKey: fixture.pair.privateKey, name: 'photo.png' } });
		await vi.waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:photo-thumbnail'));
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0][0]).toBe('/api/files/photo-id/thumbnail?revision=1');
		const decoded = fixture.createUrl.mock.calls[0][0] as Blob;
		expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(new Uint8Array(await fixture.image.arrayBuffer()));
		await unmount(app); app = null;
		expect(fixture.revokeUrl).toHaveBeenCalledWith('blob:photo-thumbnail');
	});

	it('shows photos across the vault and excludes other file types without downloading originals', async () => {
		const fixture = await photoFixture();
		const textMetadata = await encryptBlob(new TextEncoder().encode(JSON.stringify({ name: 'notes.txt', mimeType: 'text/plain', size: 8, folderId: null })), fixture.key, 'AES-GCM');
		const textRecord = { ...fixture.record, id: 'text-id', thumbnail: null, metadata: { encryptedBlob: toBase64(textMetadata.ciphertext), iv: toBase64(textMetadata.iv), algo: 'AES-GCM' as const } };
		keyStore.set({ privateKey: fixture.pair.privateKey, publicKey: fixture.pair.publicKey, publicKeyJwk: await crypto.subtle.exportKey('jwk', fixture.pair.publicKey), keyAlgo: 'ECDH-P256' });
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/thumbnail?')) return new Response(Uint8Array.from(fixture.bytes).buffer);
			if (url.includes('/chunks/')) throw new Error('The gallery fetched an original');
			return new Response(JSON.stringify(url === '/api/storage' ? { usedBytes: 48, trashBytes: 0, fileCount: 2, quotaBytes: 5000 } : { isAdmin: false }));
		});
		vi.stubGlobal('fetch', fetcher);
		app = mount(Dashboard, { target: document.body, props: { data: { files: [fixture.record, textRecord], folders: [], pending: [], listingError: null } as never } });
		await vi.waitFor(() => expect(document.body.textContent).toContain('notes.txt'));
		[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim() === 'Photos')!.click();
		await tick();
		await vi.waitFor(() => expect(document.querySelector('[aria-label="Photo gallery"]')?.textContent).toContain('photo.png'));
		expect(document.querySelector('[aria-label="Photo gallery"]')?.textContent).not.toContain('notes.txt');
		expect(fetcher.mock.calls.every(([url]) => !String(url).includes('/chunks/'))).toBe(true);
	});

	it('copies an active link and reports a revoke failure instead of marking it revoked', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
		const link: ShareLinkRow = { id: 'link-id', token: 'private-link-token', maxDownloads: 3, downloadCount: 1, expiresAt: null, revokedAt: null, createdAt: '2026-11-01T00:00:00Z', versionNumber: 2 };
		const onChanged = vi.fn(async () => {});
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Could not revoke this link' }), { status: 502 })));
		app = mount(ShareLinksList, { target: document.body, props: { links: [link], fileId: 'file-id', onChanged } });
		(document.querySelector('[aria-label="Copy share link"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/private-link-token`));
		(document.querySelector('[aria-label="Revoke share link"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not revoke'));
		expect(onChanged).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain('Active');
		expect(document.body.textContent).toContain('Version 2');
	});
});
