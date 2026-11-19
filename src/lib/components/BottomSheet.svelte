<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	let {
		open,
		title,
		onClose,
		children
	}: {
		open: boolean;
		/** Accessible name for the dialog. */
		title: string;
		onClose: () => void;
		children: Snippet;
	} = $props();

	// Honour "reduce motion": same layout, no slide or fade.
	const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const slide = reduceMotion ? 0 : 260;
	const dim = reduceMotion ? 0 : 180;

	// Freeze the page behind the sheet while it's open.
	$effect(() => {
		if (!open) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => (document.body.style.overflow = previous);
	});

	// Drag the handle down to dismiss (touch, pen or mouse).
	let dragY = $state(0);
	let dragging = $state(false);
	let startY = 0;

	function onPointerDown(e: PointerEvent) {
		dragging = true;
		startY = e.clientY;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (dragging) dragY = Math.max(0, e.clientY - startY);
	}
	function onPointerEnd() {
		if (!dragging) return;
		dragging = false;
		const shouldClose = dragY > 90;
		dragY = 0;
		if (shouldClose) onClose();
	}
</script>

<svelte:window onkeydown={open ? (e) => e.key === 'Escape' && onClose() : undefined} />

{#if open}
	<div class="fixed inset-0 z-50 flex items-end justify-center">
		<button
			type="button"
			class="absolute inset-0 cursor-default bg-black/70 backdrop-blur-[2px]"
			aria-label="Close"
			tabindex="-1"
			onclick={onClose}
			transition:fade={{ duration: dim }}
		></button>

		<div
			role="dialog"
			aria-modal="true"
			aria-label={title}
			class="relative w-full max-w-lg rounded-t-[1.25rem] border border-b-0 border-[var(--color-border-strong)] bg-[var(--color-surface-2)] pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_40px_rgba(0,0,0,0.5)]"
			style="transform: translateY({dragY}px); transition: {dragging ? 'none' : 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'};"
			transition:fly={{ y: 320, duration: slide, easing: cubicOut, opacity: 1 }}
		>
			<!-- Grab handle: the drag-to-dismiss target -->
			<div
				class="flex cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerEnd}
				onpointercancel={onPointerEnd}
				role="presentation"
			>
				<span class="h-1 w-10 rounded-full bg-[var(--color-border-strong)]"></span>
			</div>

			{@render children()}
		</div>
	</div>
{/if}