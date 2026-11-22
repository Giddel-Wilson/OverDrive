<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';
	import { lockBodyScroll } from '$lib/body-scroll-lock';

	let {
		open,
		title,
		onClose,
		size = 'md',
		dismissable = true,
		scrollable = true,
		contentClass = '',
		zIndex = 50,
		passThrough = false,
		children
	}: {
		open: boolean;
		title: string;
		onClose: () => void;
		size?: 'sm' | 'md' | 'lg' | 'xl';
		/** false = no Escape / backdrop dismissal (e.g. a kit the user must acknowledge). */
		dismissable?: boolean;
		/** false = content never scrolls (the caller must make it fit). */
		scrollable?: boolean;
		contentClass?: string;
		zIndex?: number;
		/** Let an external drag reach visible folder targets behind this dialog. */
		passThrough?: boolean;
		children: Snippet;
	} = $props();

	const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-5xl' } as const;

	// Freeze the page behind the dialog so only the dialog is interactive.
	$effect(() => {
		if (!open) return;
		return lockBodyScroll();
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && dismissable) onClose();
	}
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
	<div class="fixed inset-0 flex items-center justify-center p-4" class:pointer-events-none={passThrough} style:z-index={zIndex}>
		<button
			type="button"
			class="absolute inset-0 cursor-default bg-black/70 backdrop-blur-[2px]"
			aria-label="Close dialog"
			tabindex="-1"
			onclick={() => dismissable && onClose()}
		></button>

		<div
			role="dialog"
			aria-modal="true"
			aria-label={title}
			class:pointer-events-auto={passThrough}
			class="relative flex max-h-[90dvh] w-full {widths[size]} flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-2xl"
		>
			<div class="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
				<h2 class="min-w-0 truncate font-semibold tracking-tight">{title}</h2>
				{#if dismissable}
					<button
						type="button"
						onclick={onClose}
						aria-label="Close"
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-primary)]"
					>
						<X class="h-4 w-4" aria-hidden="true" />
					</button>
				{/if}
			</div>
			<div class="m-2 min-h-0 flex-1 p-3 {contentClass} {scrollable ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden'}">
				{@render children()}
			</div>
		</div>
	</div>
{/if}
