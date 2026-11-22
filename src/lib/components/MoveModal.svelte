<script lang="ts">
	import Modal from './Modal.svelte';
	import { Folder, FolderOpen, Home, Loader2 } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { descendantFolderIds, type FolderMap } from '$crypto/vault';

	let {
		open,
		title,
		folders,
		/** Folders being moved (so none can go into itself or its own subtree). Empty when only files move. */
		movingFolderIds = [],
		/** Where the items are now; undefined when they come from different places. */
		currentParentId,
		busy = false,
		onPick,
		onClose
	}: {
		open: boolean;
		title: string;
		folders: FolderMap;
		movingFolderIds?: string[];
		currentParentId: string | null | undefined;
		busy?: boolean;
		onPick: (parentId: string | null) => void;
		onClose: () => void;
	} = $props();

	type Row = { id: string | null; name: string; depth: number; disabled: boolean };

	const rows = $derived.by<Row[]>(() => {
		const blocked = new Set<string>(
			movingFolderIds.flatMap((id) => [id, ...descendantFolderIds(id, folders)])
		);
		const out: Row[] = [{ id: null, name: 'Vault (top level)', depth: 0, disabled: currentParentId === null }];
		const walk = (parentId: string | null, depth: number) => {
			const kids = [...folders.entries()]
				.filter(([, f]) => f.parentId === parentId)
				.sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { numeric: true, sensitivity: 'base' }));
			for (const [id, f] of kids) {
				out.push({ id, name: f.name, depth, disabled: blocked.has(id) || id === currentParentId });
				if (!blocked.has(id)) walk(id, depth + 1);
			}
		};
		walk(null, 1);
		return out;
	});
</script>

<Modal {open} {title} {onClose} size="sm">
	<ul class="space-y-1" role="listbox" aria-label="Destination folder">
		{#each rows as row (row.id ?? 'root')}
			<li>
				<button
					type="button"
					role="option"
					aria-selected={false}
					disabled={row.disabled || busy}
					onclick={() => onPick(row.id)}
					class="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left text-sm cursor-pointer hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-40"
					style="padding-left: {0.75 + row.depth * 1.1}rem"
				>
					{#if row.id === null}
						<Home class="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
					{:else if row.disabled}
						<Folder class="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
					{:else}
						<FolderOpen class="h-4 w-4 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
					{/if}
					<span class="min-w-0 truncate">{row.name}</span>
					{#if row.id === currentParentId}<span class="ml-auto text-xs text-[var(--color-text-tertiary)]">current</span>{/if}
				</button>
			</li>
		{/each}
	</ul>
	{#if busy}
		<div class="mt-3 flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
			<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" /> Moving…
		</div>
	{/if}
	<div class="mt-4 flex justify-end">
		<button type="button" class={ui.btnGhost} onclick={onClose} disabled={busy}>Cancel</button>
	</div>
</Modal>
