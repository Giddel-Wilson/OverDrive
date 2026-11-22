<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { Link2, Loader2, KeyRound } from 'lucide-svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ShareLinksList from '$lib/components/ShareLinksList.svelte';
	import { keyStore } from '$lib/stores/key-store.svelte';
	import { unwrapRecordFileKey, decryptRecordMetadata, type EncryptedFileRecord } from '$crypto/download-pipeline';
	import { shareLinkStatus, type ShareLinkRow } from '$lib/shared/shares';
	import { ui } from '$lib/ui';

	let files = $state<EncryptedFileRecord[]>([]);
	let links = $state<ShareLinkRow[]>([]);
	let loading = $state(true);
	let errorMsg = $state<string | null>(null);
	let filter = $state<'active' | 'all' | 'ended'>('active');
	let query = $state('');
	const names = new SvelteMap<string, string>();

	async function load() {
		errorMsg = null;
		try {
			const response = await fetch('/api/shares', { cache: 'no-store' });
			const body = await response.json();
			if (!response.ok) throw new Error(body.message ?? 'Could not load share links');
			files = body.files; links = body.links;
		} catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not load share links'; }
		finally { loading = false; }
	}
	onMount(load);
	$effect(() => {
		const key = keyStore.privateKey;
		const records = files;
		let cancelled = false;
		names.clear();
		if (!key) return;
		untrack(() => void (async () => {
			for (const file of records) {
				try {
					const metadata = await decryptRecordMetadata(file, await unwrapRecordFileKey(file, key));
					if (!cancelled) names.set(file.id, metadata?.name ?? 'Unnamed file');
				} catch { if (!cancelled) names.set(file.id, 'Name could not be decrypted'); }
			}
		})());
		return () => { cancelled = true; };
	});
	const filtered = $derived(links.filter((link) => (filter === 'all' || shareLinkStatus(link).active === (filter === 'active'))
		&& (!query.trim() || (names.get(link.fileId ?? '') ?? '').toLowerCase().includes(query.trim().toLowerCase()))));
	const groups = $derived(files.map((file) => ({ file, links: filtered.filter((link) => link.fileId === file.id) })).filter((group) => group.links.length));
</script>

<svelte:head><title>Share links — OverDrive</title></svelte:head>
<div class="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text-primary)]">
	<AppHeader />
	<main class="mx-auto max-w-5xl space-y-5 px-4 py-8 sm:px-6">
		<div><h1 class="flex items-center gap-2 text-xl font-semibold"><Link2 class="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" /> Share links</h1><p class="mt-2 text-sm text-[var(--color-text-secondary)]">Manage links across your vault. Each link shares the version it was created for.</p></div>
		{#if !keyStore.isUnlocked}<p class="flex items-center gap-2 {ui.alertInfo}"><KeyRound class="h-4 w-4" aria-hidden="true" /><span><a href="/settings/keys?next=/dashboard/shares" class="underline">Unlock your key</a> to see file names. You can still revoke links.</span></p>{/if}
		<div class="flex flex-wrap gap-3"><select class="{ui.input} max-w-44" aria-label="Filter share links" bind:value={filter}><option value="active">Active links</option><option value="all">All links</option><option value="ended">Ended links</option></select><input type="search" class="{ui.input} max-w-sm" placeholder="Search file names…" aria-label="Search shared file names" bind:value={query} disabled={!keyStore.isUnlocked} /><button type="button" class={ui.btnGhost} onclick={load}>Refresh</button></div>
		{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
		{#if loading}<p class="flex items-center gap-2 text-sm" role="status"><Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" /> Loading links…</p>
		{:else}
			{#each groups as group (group.file.id)}<section class="{ui.card} p-5"><h2 class="truncate font-medium">{names.get(group.file.id) ?? (keyStore.isUnlocked ? 'Decrypting name…' : `Locked file ${group.file.id.slice(0, 8)}`)}</h2>{#if group.file.deletedAt}<p class="mt-1 text-xs text-[var(--color-text-tertiary)]">In the trash; its links are unavailable until restored.</p>{/if}<ShareLinksList links={group.links} fileId={group.file.id} onChanged={load} /></section>
			{:else}{#if !errorMsg}<p class="py-10 text-center text-sm text-[var(--color-text-tertiary)]">No {filter === 'all' ? '' : `${filter} `}links to show. Create a link from a file’s Share action in the vault.</p>{/if}{/each}
		{/if}
	</main>
</div>
