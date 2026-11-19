<script lang="ts">
	import { Download, Loader2, CheckCircle2, AlertTriangle } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { keyStore } from '$lib/stores/key-store.svelte';
	import {
		canStreamToDisk,
		createBlobSink,
		createDiskSink,
		triggerBrowserDownload,
		type EncryptedFileRecord,
		type PlaintextSink
	} from '$crypto/download-pipeline';
	import { exportVault, type ExportProgress, type ExportResult } from '$crypto/export-vault';
	import type { FolderRecord } from '$crypto/vault';

	let busy = $state(false);
	let progress = $state<ExportProgress | null>(null);
	let result = $state<ExportResult | null>(null);
	let errorMsg = $state<string | null>(null);
	let controller: AbortController | null = null;

	const streaming = canStreamToDisk();

	async function start() {
		const privateKey = keyStore.privateKey;
		if (!privateKey) return;
		errorMsg = null;
		result = null;
		progress = null;

		const filename = `endtoend-encrypt-export-${new Date().toISOString().slice(0, 10)}.zip`;

		// The save dialog needs the click's user gesture, so it opens BEFORE any
		// network work. Chromium browsers then stream straight to disk (flat
		// memory, any size); others build the zip in memory and download it.
		let sink: PlaintextSink | null = null;
		let toBlob: (() => Blob) | null = null;
		if (streaming) {
			sink = await createDiskSink(filename, 'application/zip');
			if (!sink) return; // dialog cancelled
		} else {
			const mem = createBlobSink('application/zip');
			sink = mem.sink;
			toBlob = mem.toBlob;
		}

		busy = true;
		controller = new AbortController();
		try {
			const [filesRes, foldersRes] = await Promise.all([fetch('/api/files'), fetch('/api/folders')]);
			if (!filesRes.ok || !foldersRes.ok) throw new Error('Could not load your vault');
			const { files } = (await filesRes.json()) as { files: EncryptedFileRecord[] };
			const { folders } = (await foldersRes.json()) as { folders: FolderRecord[] };

			result = await exportVault({
				files,
				folders,
				privateKey,
				sink,
				signal: controller.signal,
				onProgress: (p) => (progress = p)
			});
			if (toBlob) triggerBrowserDownload(toBlob(), filename);
		} catch (e) {
			errorMsg =
				e instanceof DOMException && e.name === 'AbortError'
					? 'Export cancelled.'
					: e instanceof Error
						? e.message
						: 'Export failed';
		} finally {
			busy = false;
			controller = null;
		}
	}
</script>

<div class="space-y-4">
	<p class="text-sm text-[var(--color-text-secondary)]">
		Decrypts every file in your vault — in this browser — into a single .zip that keeps your folder structure. Nothing is uploaded. Trashed files
		and unfinished uploads are skipped.
	</p>

	{#if !keyStore.isUnlocked}
		<div class={ui.alertInfo}>
			Your key is locked in this tab. <a href="/settings/keys" class="underline" style="color: var(--color-accent)">Unlock it</a> first.
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<button type="button" class={ui.btnGhost} onclick={start} disabled={busy}>
				{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Download class="h-4 w-4" aria-hidden="true" />{/if}
				Export everything (decrypted .zip)
			</button>
			{#if busy}
				<button type="button" class={ui.btnGhost} onclick={() => controller?.abort()}>Cancel</button>
			{/if}
		</div>
		{#if !streaming}
			<p class="text-xs text-[var(--color-text-tertiary)]">
				This browser can't stream to disk, so the archive is built in memory first — fine for a few GB at most. Use Chrome or Edge for very
				large vaults.
			</p>
		{/if}
	{/if}

	{#if busy && progress}
		<div class="space-y-1.5">
			<p class="{ui.mono} truncate text-xs text-[var(--color-text-secondary)]">
				{#if progress.phase === 'preparing'}Reading your folder structure…
				{:else if progress.phase === 'finalizing'}Finishing the archive…
				{:else}{progress.fileIndex}/{progress.fileCount} · {progress.currentName}{/if}
			</p>
			<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]">
				<div class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300" style="width: {progress.percent}%"></div>
			</div>
		</div>
	{/if}

	{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}

	{#if result}
		<div class={result.failed.length ? ui.alertInfo : ui.alertOk}>
			<p class="flex items-center gap-2">
				<CheckCircle2 class="h-4 w-4" aria-hidden="true" /> Exported {result.exported} file{result.exported === 1 ? '' : 's'}.
			</p>
			{#if result.failed.length > 0}
				<p class="mt-2 flex items-start gap-2 text-[var(--color-danger)]">
					<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
					{result.failed.length} file{result.failed.length === 1 ? '' : 's'} could not be exported cleanly — see EXPORT-REPORT.txt inside the zip.
				</p>
			{/if}
		</div>
	{/if}
</div>
