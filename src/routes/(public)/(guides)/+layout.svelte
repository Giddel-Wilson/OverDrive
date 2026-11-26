<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<main class="mx-auto max-w-3xl px-6 py-14 sm:py-20">
	<article>
		{@render children()}
	</article>
</main>

<style>
	article :global(h1) { font-size: clamp(2.25rem, 5vw, 3rem); font-weight: 600; letter-spacing: -0.035em; line-height: 1.1; text-wrap: balance; }
	article :global(h2) { margin-top: 2.5rem; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; }
	article :global(p), article :global(ol) { margin-top: 0.85rem; line-height: 1.75; color: var(--color-text-secondary); }
	article :global(ol) { list-style: decimal; padding-left: 1.5rem; }
	article :global(li) { padding-left: 0.3rem; margin-top: 0.6rem; }
	article :global(a) { color: var(--color-accent); text-decoration: underline; text-underline-offset: 0.2em; }
	article :global(strong) { color: var(--color-text-primary); font-weight: 600; }
</style>
