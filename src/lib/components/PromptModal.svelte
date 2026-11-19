<script lang="ts">
	import Modal from './Modal.svelte';
	import { Loader2 } from 'lucide-svelte';
	import { ui } from '$lib/ui';

	let {
		open,
		title,
		label,
		initial = '',
		confirmLabel = 'Save',
		busy = false,
		onSubmit,
		onClose
	}: {
		open: boolean;
		title: string;
		label: string;
		initial?: string;
		confirmLabel?: string;
		busy?: boolean;
		onSubmit: (value: string) => void;
		onClose: () => void;
	} = $props();

	let value = $state('');
	let input: HTMLInputElement | undefined = $state();

	$effect(() => {
		if (open) {
			value = initial;
			queueMicrotask(() => {
				input?.focus();
				input?.select();
			});
		}
	});

	const trimmed = $derived(value.trim());
	const invalid = $derived(trimmed.length === 0 || trimmed.length > 200 || /[/\\]/.test(trimmed));

	function submit(e: Event) {
		e.preventDefault();
		if (!invalid && !busy) onSubmit(trimmed);
	}
</script>

<Modal {open} {title} {onClose} size="sm">
	<form class="space-y-4" onsubmit={submit}>
		<div class="space-y-1.5">
			<label for="prompt-input" class={ui.label}>{label}</label>
			<input id="prompt-input" bind:this={input} bind:value maxlength="200" class={ui.input} autocomplete="off" />
			{#if trimmed.length > 0 && /[/\\]/.test(trimmed)}
				<p class="text-xs text-[var(--color-danger)]">Names can't contain / or \</p>
			{/if}
		</div>
		<div class="flex justify-end gap-2">
			<button type="button" class={ui.btnGhost} onclick={onClose} disabled={busy}>Cancel</button>
			<button type="submit" class={ui.btnPrimary} disabled={invalid || busy}>
				{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
				{confirmLabel}
			</button>
		</div>
	</form>
</Modal>
