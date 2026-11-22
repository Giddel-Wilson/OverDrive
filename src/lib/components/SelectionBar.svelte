<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Loader2 } from 'lucide-svelte';
	import type { MenuAction } from './RowMenu.svelte';

	let {
		count,
		actions,
		progress = null
	}: {
		count: number;
		actions: MenuAction[];
		/** Shown instead of the buttons while a long action (e.g. a zip download) is running. */
		progress?: string | null;
	} = $props();

	const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
</script>

<div
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:bottom-6 sm:p-0"
	transition:fly={{ y: 32, duration: reduceMotion ? 0 : 200, easing: cubicOut }}
>
	<div
		class="pointer-events-auto flex w-full max-w-xl items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/95 px-2 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur sm:w-auto"
		role="toolbar"
		aria-label="Actions for selected items"
	>
		<div class="min-w-0 px-2">
			<p class="font-mono-data whitespace-nowrap text-sm text-[var(--color-text-primary)]">{count} selected</p>
		</div>

		<div class="ml-auto flex items-center gap-1 sm:ml-2">
			{#if progress}
				<span class="flex items-center gap-2 px-2 text-xs text-[var(--color-text-secondary)]">
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					<span class="font-mono-data max-w-40 truncate">{progress}</span>
				</span>
			{:else}
				{#each actions as action (action.label)}
					{@const Icon = action.icon}
					<button
						type="button"
						disabled={action.disabled}
						onclick={action.onclick}
						aria-label={action.label}
						title={action.label}
						class="flex h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-3 text-sm font-medium hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-50 {action.danger
							? 'text-[var(--color-danger)]'
							: 'text-[var(--color-text-primary)]'}"
					>
						<Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
						<span class="hidden sm:inline">{action.label}</span>
					</button>
				{/each}
			{/if}
		</div>
	</div>
</div>
