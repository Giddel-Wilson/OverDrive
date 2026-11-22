<script lang="ts">
	import { onMount } from 'svelte';
	import { Image as ImageIcon, Loader2 } from 'lucide-svelte';
	import { fetchPhotoThumbnail } from '$crypto/thumbnails';
	import type { EncryptedFileRecord } from '$crypto/download-pipeline';

	let { record, privateKey, name }: { record: EncryptedFileRecord; privateKey: CryptoKey | null; name: string } = $props();
	let container: HTMLDivElement;
	let visible = $state(false);
	let url = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state(false);

	onMount(() => {
		if (typeof IntersectionObserver === 'undefined') { visible = true; return; }
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) { visible = true; observer.disconnect(); }
		}, { rootMargin: '200px' });
		observer.observe(container);
		return () => observer.disconnect();
	});

	$effect(() => {
		const file = record;
		const key = privateKey;
		url = null;
		failed = false;
		loading = false;
		if (!visible || !key || !file.thumbnail) return;
		const controller = new AbortController();
		let objectUrl: string | null = null;
		loading = true;
		void fetchPhotoThumbnail(file, key, controller.signal).then((blob) => {
			if (controller.signal.aborted) return;
			objectUrl = URL.createObjectURL(blob);
			url = objectUrl;
		}).catch(() => { if (!controller.signal.aborted) failed = true; })
			.finally(() => { if (!controller.signal.aborted) loading = false; });
		return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
	});
</script>

<div bind:this={container} class="flex aspect-square w-full items-center justify-center overflow-hidden bg-[var(--color-surface-3)]">
	{#if url}
		<img src={url} alt={name} class="h-full w-full object-cover" loading="lazy" />
	{:else if loading}
		<Loader2 class="h-6 w-6 animate-spin text-[var(--color-text-tertiary)]" aria-label="Loading thumbnail" />
	{:else}
		<div class="flex flex-col items-center gap-2 px-3 text-center text-[var(--color-text-tertiary)]">
			<ImageIcon class="h-8 w-8" aria-hidden="true" />
			<span class="text-xs">{failed ? 'Thumbnail unavailable' : 'No thumbnail yet'}</span>
		</div>
	{/if}
</div>
