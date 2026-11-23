<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2, ShieldAlert } from 'lucide-svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import BackupSettings from '$lib/components/BackupSettings.svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';
	import { timeAgo } from '$lib/format';

	interface UserRow {
		id: string;
		email: string;
		displayName: string;
		createdAt: string;
		lastLoginAt: string | null;
		usedBytes: number;
		quotaOverride: number | null;
		quotaBytes: number;
		isAdmin: boolean;
	}

	const GIB = 1024 ** 3;

	let phase = $state<'loading' | 'forbidden' | 'ready'>('loading');
	let users = $state<UserRow[]>([]);
	let defaultQuota = $state(0);
	let errorMsg = $state<string | null>(null);

	// per-user quota editing
	let editingId = $state<string | null>(null);
	let editValue = $state('');
	let savingId = $state<string | null>(null);

	async function load() {
		errorMsg = null;
		try {
			const response = await fetch('/api/admin/users');
			if (response.status === 401 || response.status === 403) return void (phase = 'forbidden');
			const body = await response.json();
			if (!response.ok) throw new Error(body.message ?? 'Could not load accounts');
			users = body.users;
			defaultQuota = body.defaultQuotaBytes;
		} catch (error) {
			errorMsg = error instanceof Error ? error.message : 'Could not load accounts';
		}
		phase = 'ready';
	}
	onMount(load);

	function startEdit(u: UserRow) {
		editingId = u.id;
		editValue = u.quotaOverride === null ? '' : String(u.quotaOverride / GIB);
	}

	/** Blank = back to the server default; 0 = unlimited; otherwise a number of GB. */
	async function saveQuota(u: UserRow) {
		errorMsg = null;
		const trimmed = editValue.trim();
		const quotaGbValue = trimmed === '' ? null : Number(trimmed);
		if (quotaGbValue !== null && (!Number.isFinite(quotaGbValue) || quotaGbValue < 0)) {
			errorMsg = 'Enter a number of GB (0 = unlimited), or leave it blank for the default.';
			return;
		}
		savingId = u.id;
		try {
			const res = await fetch(`/api/admin/users/${u.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ quotaGb: quotaGbValue })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not save');
			editingId = null;
			await load();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Something went wrong';
		} finally {
			savingId = null;
		}
	}

	const quotaText = (bytes: number) => (bytes === 0 ? 'Unlimited' : formatBytes(bytes));
</script>

<svelte:head>
	<title>Admin — OverDrive</title>
</svelte:head>

<div class="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text-primary)]">
	<AppHeader />

	<main class="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
		{#if phase === 'loading'}
			<Loader2 class="h-5 w-5 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
		{:else if phase === 'forbidden'}
			<div class="flex items-start gap-3 {ui.alertInfo}">
				<ShieldAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<p>This page is for admins. Add your email to <span class="font-mono-data">ADMIN_EMAILS</span> in the server's environment variables.</p>
			</div>
		{:else}
			<div>
				<h1 class="text-xl font-semibold tracking-tight">Admin</h1>
				<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">Manage account storage limits and database backups. Every account has its own private, encrypted vault.</p>
			</div>

			{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
			<BackupSettings />

			<!-- Users -->
			<section class="{ui.card} p-5" aria-labelledby="sec-users">
				<h2 id="sec-users" class="font-medium">People</h2>
				<p class="mt-1 text-xs text-[var(--color-text-tertiary)]">Server default: {quotaText(defaultQuota)} per account. Blank = default, 0 = unlimited.</p>
				<ul class="mt-3 divide-y divide-[var(--color-border)]">
					{#each users as u (u.id)}
						<li class="space-y-2 py-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">
										{u.email}
										{#if u.isAdmin}<span class="ml-1.5 rounded-full bg-[var(--color-accent-bg)] px-2 py-0.5 text-xs font-normal text-[var(--color-accent)]">admin</span>{/if}
									</p>
									<p class="font-mono-data text-xs text-[var(--color-text-tertiary)]">
										Joined {timeAgo(u.createdAt)}{u.lastLoginAt ? ` · last sign-in ${timeAgo(u.lastLoginAt)}` : ''}
									</p>
								</div>
								<p class="font-mono-data shrink-0 text-right text-xs text-[var(--color-text-secondary)]">
									{formatBytes(u.usedBytes)}<br />
									<span class="text-[var(--color-text-tertiary)]">of {quotaText(u.quotaBytes)}{u.quotaOverride !== null ? ' (custom)' : ''}</span>
								</p>
							</div>

							{#if editingId === u.id}
								<form class="flex flex-wrap items-center gap-2" onsubmit={(e) => (e.preventDefault(), saveQuota(u))}>
									<input type="text" inputmode="decimal" bind:value={editValue} placeholder="GB (blank = default)" aria-label="Storage in GB" class="{ui.input} h-10 w-44" />
									<button type="submit" class={ui.btnPrimary} disabled={savingId === u.id}>
										{#if savingId === u.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if} Save
									</button>
									<button type="button" class={ui.btnGhost} onclick={() => (editingId = null)}>Cancel</button>
								</form>
							{:else}
								<button type="button" class="cursor-pointer text-xs underline" style="color: var(--color-accent)" onclick={() => startEdit(u)}>Change storage limit</button>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</main>
</div>
