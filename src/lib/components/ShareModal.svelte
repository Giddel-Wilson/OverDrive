<script lang="ts">
	import { Loader2, Copy, Check } from 'lucide-svelte';
	import Modal from './Modal.svelte';
	import ShareLinksList from './ShareLinksList.svelte';
	import { ui } from '$lib/ui';
	import { createShareLink } from '$crypto/share-pipeline';
	import type { EncryptedFileRecord } from '$crypto/download-pipeline';
	import type { ShareLinkRow } from '$lib/shared/shares';

	let { open, record, ownerPrivateKey, onClose }: {
		open: boolean; record: EncryptedFileRecord | null; ownerPrivateKey: CryptoKey; onClose: () => void;
	} = $props();
	let password = $state('');
	let confirmPassword = $state('');
	let expiryDays = $state<number | ''>('');
	let maxDownloads = $state<number | ''>('');
	let busy = $state(false);
	let loadingLinks = $state(false);
	let errorMsg = $state<string | null>(null);
	let createdUrl = $state<string | null>(null);
	let copied = $state(false);
	let links = $state<ShareLinkRow[]>([]);

	async function loadLinks(id: string, signal?: AbortSignal) {
		const response = await fetch(`/api/files/${id}/share`, { signal, cache: 'no-store' });
		const body = await response.json();
		if (!response.ok) throw new Error(body.message ?? 'Could not load share links');
		if (open && record?.id === id && !signal?.aborted) links = body.links;
	}
	$effect(() => {
		const file = record;
		links = []; createdUrl = null; password = ''; confirmPassword = ''; errorMsg = null;
		expiryDays = ''; maxDownloads = ''; copied = false;
		if (!open || !file) return;
		const controller = new AbortController();
		loadingLinks = true;
		void loadLinks(file.id, controller.signal).catch((error) => {
			if (!controller.signal.aborted) errorMsg = error instanceof Error ? error.message : 'Could not load share links';
		}).finally(() => { if (!controller.signal.aborted) loadingLinks = false; });
		return () => controller.abort();
	});

	async function create(event: Event) {
		event.preventDefault();
		const file = record;
		if (!file || busy) return;
		errorMsg = null;
		if (password.length < 8) { errorMsg = 'Share password must be at least 8 characters.'; return; }
		if (password !== confirmPassword) { errorMsg = 'Passwords do not match.'; return; }
		busy = true;
		try {
			const result = await createShareLink(file, ownerPrivateKey, password, {
				expiresAt: expiryDays === '' ? null : new Date(Date.now() + expiryDays * 86_400_000).toISOString(),
				maxDownloads: maxDownloads === '' ? null : maxDownloads
			});
			createdUrl = `${window.location.origin}${result.url}`;
			password = ''; confirmPassword = '';
			await loadLinks(file.id);
		} catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not create a share link'; }
		finally { busy = false; }
	}
	async function copy() {
		if (!createdUrl) return;
		try { await navigator.clipboard.writeText(createdUrl); copied = true; setTimeout(() => { copied = false; }, 1500); }
		catch { errorMsg = 'Could not copy the link. Select and copy it from the field.'; }
	}
</script>

<Modal {open} title="Share links" contentClass="share-scrollbar" dismissable={!busy} {onClose}>
	<p class="text-sm text-[var(--color-text-secondary)]">Anyone with a link and its password can decrypt this version of the file. Share the password through a different channel from the link.</p>
	{#if errorMsg}<div class="mt-4 {ui.alertDanger}" role="alert">{errorMsg}</div>{/if}
	{#if createdUrl}
		<div class="mt-5 space-y-3"><label for="created-share-url" class="text-sm font-medium">Link created</label><div class="flex gap-2"><input id="created-share-url" readonly value={createdUrl} class="{ui.input} font-mono-data text-xs" /><button type="button" class={ui.iconBtn} onclick={copy} aria-label="Copy new share link">{#if copied}<Check class="h-4 w-4" aria-hidden="true" />{:else}<Copy class="h-4 w-4" aria-hidden="true" />{/if}</button></div><button type="button" class="cursor-pointer text-sm underline" onclick={() => { createdUrl = null; }}>Create another link</button></div>
	{:else}
		<form class="mt-5 space-y-4" onsubmit={create}>
			<div class="space-y-1.5"><label for="share-password" class="text-sm font-medium">Share password</label><input id="share-password" class={ui.input} type="password" required minlength="8" maxlength="256" autocomplete="new-password" bind:value={password} /></div>
			<div class="space-y-1.5"><label for="share-password-confirm" class="text-sm font-medium">Confirm password</label><input id="share-password-confirm" class={ui.input} type="password" required autocomplete="new-password" bind:value={confirmPassword} /></div>
			<div class="grid grid-cols-2 gap-3"><div class="space-y-1.5"><label for="share-expiry-days" class="text-sm font-medium">Expires in days</label><input id="share-expiry-days" class={ui.input} type="number" min="1" step="1" placeholder="Never" bind:value={expiryDays} /></div><div class="space-y-1.5"><label for="share-max-downloads" class="text-sm font-medium">Max downloads</label><input id="share-max-downloads" class={ui.input} type="number" min="1" max="10000" step="1" placeholder="Unlimited" bind:value={maxDownloads} /></div></div>
			<button type="submit" class="{ui.btnPrimary} w-full" disabled={busy}>{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if} Create link</button>
		</form>
	{/if}
	<div class="mt-6 border-t border-[var(--color-border)] pt-4"><h3 class="text-sm font-medium">Existing links</h3>{#if loadingLinks}<p class="flex items-center gap-2 py-3 text-sm" role="status"><Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" /> Loading links…</p>{:else if record}<ShareLinksList {links} fileId={record.id} onChanged={() => loadLinks(record!.id)} />{/if}</div>
</Modal>
