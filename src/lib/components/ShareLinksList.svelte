<script lang="ts">
	import { Copy, Check, Ban, Loader2 } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { shareLinkStatus, type ShareLinkRow } from '$lib/shared/shares';
	let { links, fileId, onChanged }: { links: ShareLinkRow[]; fileId: string; onChanged: () => Promise<void> } = $props();
	let copied = $state<string | null>(null);
	let revoking = $state<string | null>(null);
	let errorMsg = $state<string | null>(null);

	async function copy(link: ShareLinkRow) {
		errorMsg = null;
		try { await navigator.clipboard.writeText(`${window.location.origin}/share/${link.token}`); copied = link.id; setTimeout(() => { copied = null; }, 1500); }
		catch { errorMsg = 'Could not copy the link. Check clipboard access in your browser.'; }
	}
	async function revoke(link: ShareLinkRow) {
		revoking = link.id;
		errorMsg = null;
		try {
			const response = await fetch(`/api/files/${fileId}/share?token=${encodeURIComponent(link.token)}`, { method: 'DELETE' });
			if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message ?? 'Could not revoke this link'); }
			await onChanged();
		} catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not revoke this link'; }
		finally { revoking = null; }
	}
	const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const admittedDownloadActive = (link: ShareLinkRow) => link.revocationReason === 'download_limit' && !!link.downloadGrantUntil && new Date(link.downloadGrantUntil).getTime() > Date.now();
</script>

{#if errorMsg}<div class="mb-3 {ui.alertDanger}" role="alert">{errorMsg}</div>{/if}
<ul class="share-scrollbar max-h-80 overflow-x-hidden overflow-y-auto divide-y divide-[var(--color-border)] pr-2">
	{#each links as link (link.id)}
		{@const status = shareLinkStatus(link)}
		<li class="flex flex-wrap items-center justify-between gap-3 py-3">
			<div class="min-w-0">
				<p class="truncate text-sm"><span class={status.active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]'}>{status.label}</span> · {link.downloadCount}{link.maxDownloads !== null ? `/${link.maxDownloads}` : ''} downloads{link.versionNumber ? ` · Version ${link.versionNumber}` : ''}</p>
				<p class="mt-1 text-xs text-[var(--color-text-tertiary)]">Created {date(link.createdAt)} · {link.expiresAt ? `Expires ${date(link.expiresAt)}` : 'No expiry'}</p>
				<p class="mt-1 truncate font-mono-data text-xs text-[var(--color-text-tertiary)]">/share/{link.token}</p>
			</div>
			<div class="flex shrink-0 gap-2">
				<button type="button" class={ui.iconBtn} disabled={!status.active} onclick={() => copy(link)} aria-label="Copy share link" title="Copy link">{#if copied === link.id}<Check class="h-4 w-4" aria-hidden="true" />{:else}<Copy class="h-4 w-4" aria-hidden="true" />{/if}</button>
				{#if !link.revokedAt || admittedDownloadActive(link)}<button type="button" class={ui.iconBtnDanger} disabled={revoking !== null} onclick={() => revoke(link)} aria-label="Revoke share link" title={link.revokedAt ? 'Stop active downloads' : 'Revoke link'}>{#if revoking === link.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Ban class="h-4 w-4" aria-hidden="true" />{/if}</button>{/if}
			</div>
		</li>
	{:else}<li class="py-4 text-sm text-[var(--color-text-tertiary)]">No links to show.</li>{/each}
</ul>
