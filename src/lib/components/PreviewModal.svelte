<script lang="ts">
	import Modal from './Modal.svelte';
	import { Download, Loader2, ShieldCheck } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';
	import { previewInfo } from '$lib/preview';
	import {
		createBlobSink,
		decryptFileToSink,
		unwrapRecordFileKey,
		type DecryptedMetadata,
		type EncryptedFileRecord
	} from '$crypto/download-pipeline';

	let {
		record,
		meta,
		privateKey,
		onClose,
		onDownload
	}: {
		record: EncryptedFileRecord | null;
		meta: DecryptedMetadata | null;
		privateKey: CryptoKey | null;
		onClose: () => void;
		onDownload: () => void;
	} = $props();

	let percent = $state(0);
	let url = $state<string | null>(null);
	let text = $state<string | null>(null);
	let errorMsg = $state<string | null>(null);
	let loading = $state(false);

	const info = $derived(previewInfo(meta));

	// Decrypt when a file is opened; throw the result away when it's closed
	// or a different file is opened first (the `cancelled` flag).
	$effect(() => {
		const rec = record;
		const m = meta;
		const key = privateKey;
		const i = previewInfo(m);
		if (!rec || !m || !key || !i) return;

		let cancelled = false;
		let objectUrl: string | null = null;
		percent = 0;
		url = null;
		text = null;
		errorMsg = null;
		loading = true;

		(async () => {
			try {
				const fileKey = await unwrapRecordFileKey(rec, key);
				const { sink, toBlob } = createBlobSink(i.mime);
				await decryptFileToSink(rec, fileKey, sink, { onProgress: (p) => !cancelled && (percent = p.percent) });
				if (cancelled) return;
				const blob = toBlob();
				if (i.kind === 'text') text = await blob.text();
				else {
					objectUrl = URL.createObjectURL(blob);
					url = objectUrl;
				}
			} catch (e) {
				if (!cancelled) errorMsg = e instanceof Error ? e.message : 'Could not preview this file';
			} finally {
				if (!cancelled) loading = false;
			}
		})();

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	});
</script>

<Modal open={record !== null} title={meta?.name ?? 'Preview'} {onClose} size="xl">
	{#if meta}
		<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
			<p class="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
				<ShieldCheck class="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
				Decrypted in your browser · {formatBytes(meta.size)} · never leaves this tab
			</p>
			<button type="button" class={ui.btnGhost} onclick={onDownload}>
				<Download class="h-4 w-4" aria-hidden="true" /> Download
			</button>
		</div>
	{/if}

	{#if errorMsg}
		<div class={ui.alertDanger} role="alert">{errorMsg}</div>
	{:else if loading}
		<div class="flex flex-col items-center justify-center gap-3 py-16">
			<Loader2 class="h-8 w-8 animate-spin text-[var(--color-accent)]" aria-hidden="true" />
			<p class="{ui.mono} text-sm text-[var(--color-text-secondary)]">Decrypting… {Math.round(percent)}%</p>
		</div>
	{:else if info && url}
		<div class="flex justify-center">
			{#if info.kind === 'image'}
				<img src={url} alt={meta?.name ?? ''} class="max-h-[70dvh] max-w-full rounded-[var(--radius-md)] object-contain" />
			{:else if info.kind === 'video'}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={url} controls class="max-h-[70dvh] max-w-full rounded-[var(--radius-md)]"></video>
			{:else if info.kind === 'audio'}
				<audio src={url} controls class="w-full max-w-lg"></audio>
			{:else if info.kind === 'pdf'}
				<iframe src={url} title={meta?.name ?? 'PDF preview'} class="h-[70dvh] w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white"></iframe>
			{/if}
		</div>
		{#if info.kind === 'pdf'}
			<p class="mt-3 text-center text-xs text-[var(--color-text-tertiary)]">
				PDF not showing? Some mobile browsers can't display PDFs inline — use Download.
			</p>
		{/if}
	{:else if info?.kind === 'text' && text !== null}
		<pre class="{ui.mono} max-h-[70dvh] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs leading-relaxed">{text}</pre>
	{:else if !info}
		<p class="py-10 text-center text-sm text-[var(--color-text-tertiary)]">No preview for this file type — use Download.</p>
	{/if}
</Modal>
