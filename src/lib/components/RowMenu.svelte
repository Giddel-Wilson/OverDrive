<script module lang="ts">
	// lucide-svelte icons are class components; they all share one shape.
	import type { Download } from 'lucide-svelte';

	export interface MenuAction {
		label: string;
		icon: typeof Download;
		onclick: () => void;
		danger?: boolean;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	import { EllipsisVertical } from 'lucide-svelte';
	import BottomSheet from './BottomSheet.svelte';
	import { ui } from '$lib/ui';

	let { title, actions }: { title: string; actions: MenuAction[] } = $props();

	let open = $state(false);

	function run(action: MenuAction) {
		open = false;
		action.onclick();
	}
</script>

<button type="button" class={ui.iconBtn} aria-label="Actions for {title}" aria-haspopup="dialog" aria-expanded={open} onclick={() => (open = true)}>
	<EllipsisVertical class="h-4 w-4" aria-hidden="true" />
</button>

<BottomSheet {open} title="Actions for {title}" onClose={() => (open = false)}>
	<p class="truncate px-5 pb-1 pt-2 text-sm font-medium">{title}</p>
	<ul class="p-2">
		{#each actions as action (action.label)}
			{@const Icon = action.icon}
			<li>
				<button
					type="button"
					disabled={action.disabled}
					onclick={() => run(action)}
					class="flex h-12 w-full cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-3 text-left text-sm hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-50 {action.danger
						? 'text-[var(--color-danger)]'
						: 'text-[var(--color-text-primary)]'}"
				>
					<Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
					{action.label}
				</button>
			</li>
		{/each}
	</ul>
</BottomSheet>