<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ShieldCheck, UploadCloud, Lock, Loader2 } from 'lucide-svelte';
	import StrengthIndicator from './StrengthIndicator.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import { computeStrengthRating } from '$crypto/strength';
	import { encryptAndUploadFile, UploadInterruptedError, type UploadProgress } from '$crypto/upload-pipeline';
	import type { EncryptedFileRecord } from '$crypto/download-pipeline';
	import type { UploadFileEntry, UploadBatchResult } from '$lib/file-drop';
	import { chooseAutoEncryption } from '$crypto/auto-encryption';
	import type { FileAlgo, KeyAlgo } from '$crypto/types';
	import { MAX_FILE_SIZE_BYTES, formatBytes } from '$lib/shared/limits';
	import { ui, choiceClass } from '$lib/ui';

	// recipientKeyAlgo is NOT a free choice — it must match the actual
	// algorithm of recipientPublicKey (RSA-OAEP vs ECDH use incompatible
	// math), so it's a required prop derived from the account's real
	// keypair rather than a selector in this component.
	let {
		recipientPublicKey,
		recipientKeyAlgo,
		folderId = null,
		destinationLabel = 'Vault',
		findExistingFile,
		disabled = false,
		onUploaded,
		onInterrupted,
		onFinished,
		onBusyChange
	}: {
		recipientPublicKey: CryptoKey;
		recipientKeyAlgo: KeyAlgo;
		/** Folder new files are placed in (null = top level). */
		folderId?: string | null;
		destinationLabel?: string;
		/** Looks up an existing filename in the destination using locally decrypted metadata. */
		findExistingFile?: (file: File, folderId: string | null) => Promise<EncryptedFileRecord | null>;
		disabled?: boolean;
		onUploaded?: (fileId: string) => void | Promise<void>;
		/** An upload stopped part-way and was saved for resuming. */
		onInterrupted?: () => void;
		/** The batch finished without an error; count excludes cancelled files. */
		onFinished?: (count: number) => void;
		/** True while files are being encrypted/uploaded (lets a host dialog refuse to close). */
		onBusyChange?: (busy: boolean) => void;
	} = $props();

	let isDragging = $state(false);
	let manualChoice = $state<FileAlgo | null>(null);
	let selectedFileAlgo = $state<FileAlgo | null>(null);
	let choosingEncryption = $state(false);
	let progress = $state<UploadProgress | null>(null);
	let queueInfo = $state<{ index: number; total: number; name: string } | null>(null);
	let errorMsg = $state<string | null>(null);
	let doneCount = $state(0);
	let doneTimer: ReturnType<typeof setTimeout> | undefined;
	let fileInput: HTMLInputElement;
	let overwritePrompt = $state<{ name: string; resolve: (confirmed: boolean) => void } | null>(null);
	let disposed = false;

	function confirmOverwrite(name: string) {
		return new Promise<boolean>((resolve) => { overwritePrompt = { name, resolve }; });
	}

	function resolveOverwrite(confirmed: boolean) {
		const prompt = overwritePrompt;
		overwritePrompt = null;
		prompt?.resolve(confirmed);
	}

	onDestroy(() => {
		disposed = true;
		clearTimeout(doneTimer);
		resolveOverwrite(false);
	});

	const rating = $derived.by(() => {
		const algo = manualChoice ?? selectedFileAlgo;
		return algo ? computeStrengthRating(algo, recipientKeyAlgo) : null;
	});
	const uploading = $derived(queueInfo !== null);

	$effect(() => {
		onBusyChange?.(uploading);
	});

	async function handleFiles(list: FileList | null) {
		if (!list || list.length === 0 || uploading || disabled) return;
		await uploadFiles([...list].map((file) => ({ file, folderId })));
	}

	export function resetEncryptionChoice() {
		if (uploading) return;
		manualChoice = null;
		selectedFileAlgo = null;
	}

	/** Used by the vault's external-drop queue after its folder tree is prepared. */
	export async function uploadFiles(files: UploadFileEntry[], options: { automatic?: boolean } = {}): Promise<UploadBatchResult> {
		if (disposed || !files.length) return { uploaded: 0, cancelled: 0, failed: false };
		if (uploading) throw new Error('Another upload is still in progress.');
		if (options.automatic) manualChoice = null;
		const automatic = options.automatic || manualChoice === null;
		selectedFileAlgo = null;
		clearTimeout(doneTimer);
		errorMsg = null;
		doneCount = 0;

		const tooBig = files.find((entry) => entry.file.size > MAX_FILE_SIZE_BYTES)?.file;
		if (tooBig) {
			errorMsg = `"${tooBig.name}" is ${formatBytes(tooBig.size)}, which is over the ${formatBytes(MAX_FILE_SIZE_BYTES)} limit.`;
			return { uploaded: 0, cancelled: 0, failed: true };
		}

		// One after another: each file already uploads its chunks in parallel,
		// and sequential files keep browser memory bounded.
		let failed = false;
		let cancelled = 0;
		for (let i = 0; i < files.length; i++) {
			if (disposed) break;
			const entry = files[i];
			const file = entry.file;
			queueInfo = { index: i + 1, total: files.length, name: entry.relativePath ?? file.name };
			progress = null;
			try {
				const existing = await findExistingFile?.(file, entry.folderId);
				if (disposed) break;
				if (existing && !(await confirmOverwrite(entry.relativePath ?? file.name))) { cancelled++; continue; }
				if (disposed) break;
				choosingEncryption = automatic;
				const fileAlgo = automatic ? await chooseAutoEncryption(file.size) : manualChoice!;
				choosingEncryption = false;
				selectedFileAlgo = fileAlgo;
				if (disposed) break;
				const result = await encryptAndUploadFile({
					file,
					recipientPublicKey,
					choice: { fileAlgo, keyAlgo: recipientKeyAlgo },
					folderId: entry.folderId,
					replacesFileId: existing?.id,
					baseVersion: existing ? existing.versionNumber ?? 1 : undefined,
					metadataName: existing ? file.name : undefined,
					onProgress: (p) => (progress = p)
				});
				doneCount++;
				await onUploaded?.(result.fileId);
			} catch (e) {
				choosingEncryption = false;
				errorMsg = e instanceof Error ? e.message : 'Encryption or upload failed';
				if (e instanceof UploadInterruptedError) onInterrupted?.();
				failed = true;
				break;
			}
		}
		if (disposed) return { uploaded: doneCount, cancelled, failed };
		queueInfo = null;
		progress = null;
		fileInput.value = '';
		if (doneCount > 0) doneTimer = setTimeout(() => (doneCount = 0), 4000);
		if (!failed && doneCount > 0) onFinished?.(doneCount);
		return { uploaded: doneCount, cancelled, failed };
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		handleFiles(e.dataTransfer?.files ?? null);
	}

	const phaseLabel = $derived(
		choosingEncryption ? 'Choosing encryption…' : !progress
			? 'Preparing…'
			: progress.phase === 'finalizing'
				? 'Verifying upload…'
				: progress.mode === 'relay'
					? 'Uploading via secure relay…'
					: 'Encrypting and uploading…'
	);
</script>

<div class="space-y-4">
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
		<fieldset class="space-y-2">
			<legend class={ui.label}>File encryption</legend>
			<div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="File encryption algorithm">
				{#each ['AES-GCM', 'ChaCha20-Poly1305'] as algo (algo)}
					<button
						type="button"
						role="radio"
						aria-checked={(manualChoice ?? selectedFileAlgo) === algo}
						disabled={uploading || disabled}
						onclick={() => {
							const choice = algo as FileAlgo;
							manualChoice = (manualChoice ?? selectedFileAlgo) === choice ? null : choice;
							selectedFileAlgo = manualChoice;
						}}
						class="min-h-11 rounded-[var(--radius-md)] border px-3 py-2 text-sm font-mono-data transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 {choiceClass((manualChoice ?? selectedFileAlgo) === algo)}"
					>
						{algo}
					</button>
				{/each}
			</div>
		</fieldset>

		<div class="space-y-2">
			<p class={ui.label}>Key encryption</p>
			<div
				class="flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-mono-data text-[var(--color-text-secondary)]"
			>
				<Lock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				{recipientKeyAlgo === 'ECDH-P256' ? 'ECDH (P-256)' : recipientKeyAlgo}
				<span class="ml-auto text-xs text-[var(--color-text-tertiary)]">from your account key</span>
			</div>
		</div>
	</div>

	<StrengthIndicator {rating} />

	<!-- Drop zone -->
	<button
		type="button"
		class="group relative flex w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed px-6 py-7 text-center cursor-pointer transition-[border-color,background-color] duration-200 disabled:cursor-default {isDragging
			? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)]'
			: 'border-[var(--color-border)] bg-[var(--color-surface)]'}"
		disabled={uploading || disabled}
		ondragover={(e) => {
			e.preventDefault();
			isDragging = true;
		}}
		ondragleave={() => (isDragging = false)}
		ondrop={onDrop}
		onclick={() => fileInput.click()}
		aria-label="Drag and drop files or folders here, or click to choose files to encrypt and upload"
	>
		<input bind:this={fileInput} type="file" multiple disabled={uploading || disabled} class="sr-only" tabindex="-1" onchange={(e) => handleFiles((e.target as HTMLInputElement).files)} />

		{#if uploading}
			<Loader2 class="h-9 w-9 animate-spin text-[var(--color-accent)]" aria-hidden="true" />
			<div class="w-full max-w-sm space-y-1.5">
				<p class="font-mono-data text-sm text-[var(--color-text-secondary)]">{phaseLabel}</p>
				{#if queueInfo}
					<p class="truncate text-xs text-[var(--color-text-tertiary)]">
						{queueInfo.total > 1 ? `File ${queueInfo.index} of ${queueInfo.total} · ` : ''}{queueInfo.name}
					</p>
				{/if}
				<div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]">
					<div
						class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
						style="width: {progress?.percent ?? 0}%; transition-timing-function: var(--ease-standard);"
					></div>
				</div>
				{#if progress && progress.bytesTotal > 0}
					<p class="font-mono-data text-xs text-[var(--color-text-tertiary)]">
						{formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}{progress.resumedChunks ? ` · resumed (${progress.resumedChunks} chunks already stored)` : ''}
					</p>
				{/if}
			</div>
		{:else}
			<div
				class="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent-bg)] transition-transform duration-200 group-hover:scale-105"
			>
				<UploadCloud class="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
			</div>
			<div>
				<p class="font-medium">Drop files or folders to encrypt &amp; upload</p>
				<p class="mt-0.5 text-sm text-[var(--color-text-tertiary)]">
					Encrypted entirely in your browser — we never see the plaintext or your keys.
				</p>
			</div>
			<div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
				<span class="flex items-center gap-1.5"><Lock class="h-3.5 w-3.5" aria-hidden="true" /> Zero-knowledge · up to {formatBytes(MAX_FILE_SIZE_BYTES)} per file</span>
				<span>Saving to <strong class="font-medium text-[var(--color-text-secondary)]">{destinationLabel}</strong></span>
			</div>
		{/if}
	</button>

	{#if errorMsg}
		<div class={ui.alertDanger} role="alert">{errorMsg}</div>
	{/if}

	{#if doneCount > 0 && !uploading}
		<div class="flex items-center gap-2 {ui.alertOk}" role="status">
			<ShieldCheck class="h-4 w-4" aria-hidden="true" />
			{doneCount === 1 ? 'Encrypted and uploaded successfully.' : `${doneCount} files encrypted and uploaded.`}
		</div>
	{/if}
</div>

<ConfirmModal
	open={overwritePrompt !== null}
	title="File already exists"
	description={overwritePrompt ? `A file named “${overwritePrompt.name}” already exists in this folder. Continuing will overwrite the current file in your vault. The previous version will be kept in history.` : ''}
	confirmLabel="Continue"
	cancelLabel="Cancel"
	onConfirm={() => resolveOverwrite(true)}
	onCancel={() => resolveOverwrite(false)}
/>
