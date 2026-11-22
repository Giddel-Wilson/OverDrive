<script lang="ts">
	import { onMount } from 'svelte';
	import { Laptop, Smartphone, Loader2, LogOut } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { ui } from '$lib/ui';
	import { describeDevice, timeAgo } from '$lib/format';
	import { keyStore } from '$lib/stores/key-store.svelte';

	interface SessionRow {
		id: string;
		createdAt: string;
		lastSeenAt: string;
		ipAddress: string | null;
		userAgent: string | null;
		current: boolean;
	}

	let sessions = $state<SessionRow[]>([]);
	let loaded = $state(false);
	let busyId = $state<string | null>(null);
	let busyOthers = $state(false);
	let errorMsg = $state<string | null>(null);
	let retiredLegacy = $state(false);

	async function load() {
		try {
			const res = await fetch('/api/auth/sessions', { cache: 'no-store' });
			const body = await res.json();
			if (!res.ok) throw new Error(body.message ?? 'Could not load your devices');
			sessions = body.sessions;
			retiredLegacy = body.legacySessionsRetired > 0;
		} catch (error) { errorMsg = error instanceof Error ? error.message : 'Could not load your devices'; }
		finally { loaded = true; }
	}
	onMount(load);

	const others = $derived(sessions.filter((s) => !s.current));
	const isPhone = (ua: string | null) => /Android|iPhone|iPad|iPod|Mobile/i.test(ua ?? '');

	async function signOut(row: SessionRow) {
		errorMsg = null;
		busyId = row.id;
		try {
			const res = await fetch(`/api/auth/sessions/${row.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not sign that device out');
			if (row.current) {
				keyStore.lock();
				await goto('/login');
				return;
			}
			sessions = sessions.filter((s) => s.id !== row.id);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Something went wrong';
		} finally {
			busyId = null;
		}
	}

	async function signOutOthers() {
		errorMsg = null;
		busyOthers = true;
		try {
			const res = await fetch('/api/auth/sessions', { method: 'DELETE' });
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not sign the other devices out');
			sessions = sessions.filter((s) => s.current);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Something went wrong';
		} finally {
			busyOthers = false;
		}
	}
</script>

<div class="space-y-4">
	<p class="text-sm text-[var(--color-text-secondary)]">
		One entry per browser or profile. Signing in again updates that device, and signing it out takes effect immediately.
	</p>
	{#if retiredLegacy}<p class={ui.alertInfo}>Older sign-ins were signed out during the device-tracking update. Sign in again on those browsers to add them here.</p>{/if}

	{#if !loaded}
		<Loader2 class="h-4 w-4 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
	{:else if !errorMsg || sessions.length > 0}
		<ul class="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
			{#each sessions as row (row.id)}
				{@const Icon = isPhone(row.userAgent) ? Smartphone : Laptop}
				<li class="flex items-center gap-3 px-3 py-3">
					<Icon class="h-5 w-5 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
					<div class="min-w-0 flex-1">
						<p class="flex flex-wrap items-center gap-x-2 text-sm font-medium">
							<span class="truncate">{describeDevice(row.userAgent)}</span>
							{#if row.current}
								<span class="rounded-full bg-[var(--color-accent-bg)] px-2 py-0.5 text-xs font-normal text-[var(--color-accent)]">This device</span>
							{/if}
						</p>
						<p class="font-mono-data truncate text-xs text-[var(--color-text-tertiary)]">
							{row.current ? 'Active now' : `Active ${timeAgo(row.lastSeenAt)}`}{row.ipAddress ? ` · ${row.ipAddress}` : ''}
						</p>
					</div>
					<button
						type="button"
						class={ui.iconBtn}
						disabled={busyId !== null || busyOthers}
						onclick={() => signOut(row)}
						aria-label={row.current ? 'Sign out of this device' : `Sign out ${describeDevice(row.userAgent)}`}
						title="Sign out"
					>
						{#if busyId === row.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<LogOut class="h-4 w-4" aria-hidden="true" />{/if}
					</button>
				</li>
			{:else}
				<li class="px-3 py-4 text-sm text-[var(--color-text-tertiary)]">No active sessions.</li>
			{/each}
		</ul>

		{#if others.length > 0}
			<button type="button" class={ui.btnGhost} disabled={busyOthers || busyId !== null} onclick={signOutOthers}>
				{#if busyOthers}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
				Sign out all other devices ({others.length})
			</button>
		{/if}
	{/if}

	{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
</div>
