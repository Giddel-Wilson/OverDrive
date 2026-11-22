<script lang="ts">
	import { formatBytes } from '$lib/shared/limits';

	export interface Usage {
		usedBytes: number;
		trashBytes: number;
		fileCount: number;
		/** 0 = unlimited */
		quotaBytes: number;
		versionBytes?: number;
	}

	let { usage, compact = false }: { usage: Usage | null; compact?: boolean } = $props();

	const unlimited = $derived(usage !== null && usage.quotaBytes === 0);
	const ratio = $derived(usage && usage.quotaBytes > 0 ? Math.min(1, usage.usedBytes / usage.quotaBytes) : 0);
	const tone = $derived(ratio >= 0.95 ? 'var(--color-danger)' : ratio >= 0.8 ? '#f5a524' : 'var(--color-accent)');
	const label = $derived(
		!usage
			? ''
			: unlimited
				? `${formatBytes(usage.usedBytes)} used`
				: `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)}`
	);
</script>

{#if usage}
	{#if compact}
		<div class="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]" title="Storage used (files, thumbnails, versions, trash and unfinished uploads)">
			{#if !unlimited}
				<div class="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-surface-3)]" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(ratio * 100)} aria-label="Storage used">
					<div class="h-full rounded-full transition-[width] duration-300" style="width: {ratio * 100}%; background: {tone}"></div>
				</div>
			{/if}
			<span class="font-mono-data whitespace-nowrap">{label}</span>
		</div>
	{:else}
		<div class="space-y-2">
			<div class="flex items-baseline justify-between gap-3">
				<p class="font-mono-data text-sm text-[var(--color-text-primary)]">{label}</p>
				{#if !unlimited}<p class="font-mono-data text-xs text-[var(--color-text-tertiary)]">{Math.round(ratio * 100)}%</p>{/if}
			</div>
			{#if !unlimited}
				<div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(ratio * 100)} aria-label="Storage used">
					<div class="h-full rounded-full transition-[width] duration-300" style="width: {ratio * 100}%; background: {tone}"></div>
				</div>
			{/if}
			<p class="text-xs text-[var(--color-text-tertiary)]">
				{usage.fileCount} file{usage.fileCount === 1 ? '' : 's'}
				{#if usage.versionBytes}· {formatBytes(usage.versionBytes)} in previous versions{/if}
				{#if usage.trashBytes > 0}· {formatBytes(usage.trashBytes)} of it is in the trash (still counted until you delete it for good){/if}
			</p>
			{#if !unlimited && ratio >= 0.95}
				<p class="text-xs text-[var(--color-danger)]">Almost full — empty the trash or delete something, or ask the admin for more space.</p>
			{/if}
		</div>
	{/if}
{/if}
