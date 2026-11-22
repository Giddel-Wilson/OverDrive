<script lang="ts">
	import { Loader2, Upload, Download, RotateCcw, History } from 'lucide-svelte';
	import Modal from './Modal.svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';
	import { encryptAndUploadFile, UploadInterruptedError, type UploadProgress } from '$crypto/upload-pipeline';
	import { restoreFileVersion } from '$crypto/versions';
	import {
		unwrapRecordFileKey, decryptRecordMetadata, downloadAndDecryptFile, triggerBrowserDownload,
		canStreamToDisk, createDiskSink, decryptFileToSink, type EncryptedFileRecord
	} from '$crypto/download-pipeline';
	import type { KeyAlgo } from '$crypto/types';

	let { record, name, privateKey, publicKey, keyAlgo, onClose, onChanged }: {
		record: EncryptedFileRecord | null;
		name: string;
		privateKey: CryptoKey;
		publicKey: CryptoKey | null;
		keyAlgo: KeyAlgo | null;
		onClose: () => void;
		onChanged: () => Promise<void>;
	} = $props();

	let versions = $state<EncryptedFileRecord[]>([]);
	let loading = $state(false);
	let errorMsg = $state<string | null>(null);
	let busy = $state<'upload' | 'download' | 'restore' | null>(null);
	let progress = $state<UploadProgress | null>(null);
	let activeVersion = $state<string | null>(null);
	let retained = $state(5);
	let fileInput: HTMLInputElement;

	$effect(() => {
		const id = record?.id;
		const revision = record?.versionNumber;
		void revision;
		versions = [];
		errorMsg = null;
		if (!id) return;
		const controller = new AbortController();
		loading = true;
		void fetch(`/api/files/${id}/versions`, { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
			const body = await response.json();
			if (!response.ok) throw new Error(body.message ?? 'Could not load version history');
			if (!controller.signal.aborted) { versions = body.versions; retained = body.retainedVersions; }
		}).catch((error) => { if (!controller.signal.aborted) errorMsg = error instanceof Error ? error.message : 'Could not load version history'; })
			.finally(() => { if (!controller.signal.aborted) loading = false; });
		return () => controller.abort();
	});

	async function replace(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		const current = record;
		if (!file || !current || !publicKey || !keyAlgo || busy) return;
		busy = 'upload';
		errorMsg = null;
		progress = null;
		try {
			const metadata = await decryptRecordMetadata(current, await unwrapRecordFileKey(current, privateKey));
			if (!metadata) throw new Error('This file is missing encrypted metadata');
			await encryptAndUploadFile({
				file, recipientPublicKey: publicKey, choice: { fileAlgo: current.fileAlgo, keyAlgo },
				replacesFileId: current.id, baseVersion: current.versionNumber ?? 1,
				metadataName: metadata.name, folderId: metadata.folderId ?? null,
				onProgress: (value) => { progress = value; }
			});
			await onChanged();
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : 'Could not upload a new version';
			if (error instanceof UploadInterruptedError) await onChanged();
		} finally { busy = null; progress = null; }
	}

	async function restore(version: EncryptedFileRecord) {
		const current = record;
		if (!current || busy) return;
		busy = 'restore';
		activeVersion = version.id;
		errorMsg = null;
		try { await restoreFileVersion(current, version, privateKey); await onChanged(); }
		catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not restore this version'; }
		finally { busy = null; activeVersion = null; }
	}

	async function download(version: EncryptedFileRecord) {
		if (busy) return;
		busy = 'download';
		activeVersion = version.id;
		errorMsg = null;
		try {
			// Keep the save picker in the click gesture and large downloads off the heap.
			const disk = canStreamToDisk() && (version.ciphertextSizeBytes ?? 0) > 100 * 1024 * 1024 ? await createDiskSink(name) : undefined;
			if (disk === null) return;
			const key = await unwrapRecordFileKey(version, privateKey);
			if (disk) await decryptFileToSink(version, key, disk);
			else {
				const { blob, metadata } = await downloadAndDecryptFile(version, key);
				triggerBrowserDownload(blob, metadata?.name ?? name);
			}
		} catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not download this version'; }
		finally { busy = null; activeVersion = null; }
	}

	const date = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
</script>

<Modal open={record !== null} title="Version history — {name}" size="lg" dismissable={busy === null} {onClose}>
	<input bind:this={fileInput} type="file" class="hidden" onchange={replace} aria-label="Choose a new file version" />
	<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
		<p class="max-w-md text-sm text-[var(--color-text-secondary)]">Upload new content for this file. Its name and folder stay the same, and the current content is kept in history.</p>
		<button type="button" class={ui.btnPrimary} disabled={busy !== null || !publicKey || !keyAlgo} onclick={() => fileInput.click()}>
			{#if busy === 'upload'}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Upload class="h-4 w-4" aria-hidden="true" />{/if}
			Upload new version
		</button>
	</div>
	{#if progress}<p class="mb-4 text-sm" role="status">{progress.phase === 'finalizing' ? 'Verifying upload…' : `Uploading… ${Math.round(progress.percent)}%`}</p>{/if}
	{#if errorMsg}<div class="mb-4 {ui.alertDanger}" role="alert">{errorMsg}</div>{/if}
	{#if record}
		<div class="mb-3 flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] p-3">
			<History class="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
			<div><p class="text-sm font-medium">Version {record.versionNumber ?? 1} · Current</p><p class="text-xs text-[var(--color-text-tertiary)]">{formatBytes(record.ciphertextSizeBytes ?? 0)} · {date(record.contentUpdatedAt ?? record.createdAt)}</p></div>
		</div>
	{/if}
	{#if loading}
		<p class="flex items-center gap-2 py-5 text-sm" role="status"><Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" /> Loading history…</p>
	{:else}
		<ul class="divide-y divide-[var(--color-border)]">
			{#each versions as version (version.id)}
				<li class="flex flex-wrap items-center justify-between gap-3 py-3">
					<div><p class="text-sm font-medium">Version {version.versionNumber}</p><p class="text-xs text-[var(--color-text-tertiary)]">{formatBytes(version.ciphertextSizeBytes ?? 0)} · {date(version.createdAt)}</p></div>
					<div class="flex gap-2">
						<button type="button" class={ui.btnGhost} disabled={busy !== null} aria-label="Download version {version.versionNumber}" onclick={() => download(version)}><Download class="h-4 w-4" aria-hidden="true" /> Download</button>
						<button type="button" class={ui.btnGhost} disabled={busy !== null} aria-label="Restore version {version.versionNumber}" onclick={() => restore(version)}>
							{#if busy === 'restore' && activeVersion === version.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<RotateCcw class="h-4 w-4" aria-hidden="true" />{/if} Restore
						</button>
					</div>
				</li>
			{:else}<li class="py-6 text-sm text-[var(--color-text-tertiary)]">No previous versions yet.</li>{/each}
		</ul>
	{/if}
	<p class="mt-4 text-xs text-[var(--color-text-tertiary)]">The last {retained} versions, including current content, count toward your storage. Active share links keep their original version available. Restoring also keeps the content you replace.</p>
</Modal>
