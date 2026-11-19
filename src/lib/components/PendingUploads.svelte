<script lang="ts">
	import { Loader2, PlayCircle, Trash2, UploadCloud } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';
	import { discardUpload, resumeUpload, type UploadProgress } from '$crypto/upload-pipeline';
	import type { DecryptedMetadata, EncryptedFileRecord } from '$crypto/download-pipeline';

	let {
		records,
		metaFor,
		privateKey,
		onChanged
	}: {
		records: EncryptedFileRecord[];
		metaFor: (id: string) => DecryptedMetadata | 'error' | undefined;
		privateKey: CryptoKey;
		onChanged: () => void;
	} = $props();

	let activeId = $state<string | null>(null);
	let progress = $state<UploadProgress | null>(null);
	let errorMsg = $state<string | null>(null);
	let picking: EncryptedFileRecord | null = null;
	let fileInput = $state<HTMLInputElement>();

	function chooseFile(record: EncryptedFileRecord) {
		picking = record;
		errorMsg = null;
		if (!fileInput) return;
		fileInput.value = '';
		fileInput.click();
	}

	async function onFileChosen(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		const record = picking;
		if (!file || !record) return;
		activeId = record.id;
		progress = null;
		try {
			await resumeUpload({ file, record, privateKey, onProgress: (p) => (progress = p) });
			onChanged();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Could not resume the upload';
		} finally {
			activeId = null;
			progress = null;
		}
	}

	async function discard(record: EncryptedFileRecord) {
		activeId = record.id;
		errorMsg = null;
		try {
			await discardUpload(record.id);
			onChanged();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Could not discard the upload';
		} finally {
			activeId = null;
		}
	}

	const nameOf = (id: string) => {
		const m = metaFor(id);
		return m && m !== 'error' ? m.name : 'Unfinished upload';
	};
</script>

{#if records.length > 0}
	<section class="{ui.card} p-4" aria-labelledby="pending-title">
		<h2 id="pending-title" class="flex items-center gap-2 text-sm font-medium">
			<UploadCloud class="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" /> Incomplete uploads
		</h2>
		<p class="mt-1 text-xs text-[var(--color-text-tertiary)]">
			These stopped part-way. Resume by choosing the same file again — chunks already stored are skipped.
		</p>

		<input bind:this={fileInput} type="file" class="sr-only" tabindex="-1" onchange={onFileChosen} />

		<ul class="mt-3 divide-y divide-[var(--color-border)]">
			{#each records as record (record.id)}
				{@const meta = metaFor(record.id)}
				<li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
					<div class="min-w-0">
						<p class="truncate text-sm font-medium">{nameOf(record.id)}</p>
						<p class="font-mono-data text-xs text-[var(--color-text-tertiary)]">
							{meta && meta !== 'error' ? formatBytes(meta.size) : ''}
						</p>
						{#if activeId === record.id && progress}
							<div class="mt-1.5 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]">
								<div class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300" style="width: {progress.percent}%"></div>
							</div>
						{/if}
					</div>
					<div class="flex items-center gap-2 self-end sm:self-auto">
						<button type="button" class={ui.btnGhost} disabled={activeId !== null} onclick={() => chooseFile(record)}>
							{#if activeId === record.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<PlayCircle class="h-4 w-4" aria-hidden="true" />{/if}
							Resume
						</button>
						<button type="button" class={ui.iconBtnDanger} disabled={activeId !== null} onclick={() => discard(record)} aria-label="Discard unfinished upload" title="Discard">
							<Trash2 class="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
				</li>
			{/each}
		</ul>

		{#if errorMsg}<div class="mt-3 {ui.alertDanger}" role="alert">{errorMsg}</div>{/if}
	</section>
{/if}
