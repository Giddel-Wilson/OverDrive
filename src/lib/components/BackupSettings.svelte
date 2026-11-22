<script lang="ts">
	import { onMount } from 'svelte';
	import { DatabaseBackup, Loader2 } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';

	interface Status {
		configured: boolean; cronConfigured: boolean; retentionDays: number; schedule: string; stale: boolean; lastFailureAt: string | null;
		lastSuccess: { createdAt: string; bytes: number; tables: number; rows: number } | null;
	}
	let status = $state<Status | null>(null);
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	async function load() {
		const response = await fetch('/api/admin/backups', { cache: 'no-store' });
		const body = await response.json();
		if (!response.ok) throw new Error(body.message ?? 'Could not load backup status');
		status = body;
	}
	onMount(() => { void load().catch((error) => { errorMsg = error instanceof Error ? error.message : 'Could not load backup status'; }); });
	async function backup() {
		busy = true; errorMsg = null;
		try {
			const response = await fetch('/api/admin/backups', { method: 'POST' });
			const body = await response.json();
			if (!response.ok) throw new Error(body.message ?? 'Could not create a backup');
			await load();
		} catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not create a backup'; }
		finally { busy = false; }
	}
</script>

<section class="{ui.card} space-y-3 p-5">
	<h2 class="flex items-center gap-2 font-semibold"><DatabaseBackup class="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" /> Database backups</h2>
	<p class="text-sm text-[var(--color-text-secondary)]">Encrypted snapshots protect the keys and metadata needed to recover your vault.</p>
	{#if status}
		<p class="text-sm">{status.schedule} · Keep {status.retentionDays} days</p>
		{#if status.configured && !status.cronConfigured}<p class={ui.alertInfo}>Set CRON_SECRET in the deployment’s environment to enable the Vercel schedule.</p>{/if}
		{#if status.lastSuccess}<p class="text-sm text-[var(--color-text-secondary)]">Last verified backup: {new Date(status.lastSuccess.createdAt).toLocaleString()} · {formatBytes(status.lastSuccess.bytes)} · {status.lastSuccess.tables} tables</p>{:else}<p class="text-sm text-[var(--color-text-tertiary)]">No successful backup has been recorded for this deployment yet.</p>{/if}
		{#if !status.configured}<p class={ui.alertInfo}>Set the backup encryption key in this deployment’s environment to enable scheduled backups.</p>{:else if status.stale || status.lastFailureAt}<p class={ui.alertDanger} role="alert">{status.lastFailureAt ? 'The last backup attempt failed.' : 'A recent backup has not been recorded.'} Check the scheduled job and create a backup now.</p>{/if}
		<button type="button" class={ui.btnGhost} disabled={!status.configured || busy} onclick={backup}>{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<DatabaseBackup class="h-4 w-4" aria-hidden="true" />{/if} Back up now</button>
	{/if}
	{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
</section>
