<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2, Copy, Check, Ban, Plus, ShieldAlert } from 'lucide-svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import BackupSettings from '$lib/components/BackupSettings.svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';
	import { timeAgo } from '$lib/format';

	interface InviteRow {
		id: string;
		note: string | null;
		maxUses: number;
		uses: number;
		expiresAt: string | null;
		quotaBytes: number | null;
		revokedAt: string | null;
		createdAt: string;
		createdByEmail: string | null;
	}
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
	let invites = $state<InviteRow[]>([]);
	let users = $state<UserRow[]>([]);
	let defaultQuota = $state(0);
	let errorMsg = $state<string | null>(null);

	// create-invite form
	let note = $state('');
	let maxUses = $state(1);
	let expiresInDays = $state(14);
	let neverExpires = $state(false);
	let quotaMode = $state<'default' | 'custom' | 'unlimited'>('default');
	let quotaGb = $state(10);
	let creating = $state(false);
	let fresh = $state<{ code: string; link: string } | null>(null);
	let copied = $state<'code' | 'link' | null>(null);

	// per-user quota editing
	let editingId = $state<string | null>(null);
	let editValue = $state('');
	let savingId = $state<string | null>(null);

	async function load() {
		const [invRes, usersRes] = await Promise.all([fetch('/api/admin/invites'), fetch('/api/admin/users')]);
		if (invRes.status === 403 || usersRes.status === 403) return void (phase = 'forbidden');
		if (invRes.ok) invites = (await invRes.json()).invites;
		if (usersRes.ok) {
			const body = await usersRes.json();
			users = body.users;
			defaultQuota = body.defaultQuotaBytes;
		}
		phase = 'ready';
	}
	onMount(load);

	async function createInvite(e: Event) {
		e.preventDefault();
		errorMsg = null;
		creating = true;
		try {
			const res = await fetch('/api/admin/invites', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					note: note.trim() || undefined,
					maxUses,
					expiresInDays: neverExpires ? null : expiresInDays,
					quotaGb: quotaMode === 'default' ? null : quotaMode === 'unlimited' ? 0 : quotaGb
				})
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message ?? 'Could not create the invite');
			fresh = { code: data.code, link: `${location.origin}/register?invite=${data.code}` };
			note = '';
			await load();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Something went wrong';
		} finally {
			creating = false;
		}
	}

	async function copy(text: string, which: 'code' | 'link') {
		try {
			await navigator.clipboard.writeText(text);
			copied = which;
			setTimeout(() => (copied = null), 1800);
		} catch {
			/* clipboard blocked — the value is on screen */
		}
	}

	async function revoke(id: string) {
		errorMsg = null;
		const res = await fetch(`/api/admin/invites/${id}`, { method: 'DELETE' });
		if (!res.ok) errorMsg = (await res.json().catch(() => ({}))).message ?? 'Could not revoke the invite';
		await load();
	}

	const inviteStatus = (i: InviteRow) =>
		i.revokedAt
			? 'Revoked'
			: i.expiresAt && new Date(i.expiresAt) < new Date()
				? 'Expired'
				: i.uses >= i.maxUses
					? 'Used up'
					: 'Active';

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
	<title>Admin — EndToEnd Encrypt</title>
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
				<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">Invite people and see how much storage each account uses. You can't see anyone's files or names — only sizes.</p>
			</div>

			{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
			<BackupSettings />

			<!-- New invite -->
			<section class="{ui.card} space-y-4 p-5" aria-labelledby="sec-new-invite">
				<h2 id="sec-new-invite" class="font-medium">Invite someone</h2>

				{#if fresh}
					<div class="space-y-3 {ui.alertOk}">
						<p class="font-medium">Invite created — copy it now, it won't be shown again.</p>
						<div class="flex flex-wrap items-center gap-2">
							<code class="font-mono-data rounded bg-[var(--color-surface)] px-2.5 py-1.5 text-sm tracking-wider text-[var(--color-text-primary)]">{fresh.code}</code>
							<button type="button" class={ui.btnGhost} onclick={() => copy(fresh!.code, 'code')}>
								{#if copied === 'code'}<Check class="h-4 w-4" aria-hidden="true" /> Copied{:else}<Copy class="h-4 w-4" aria-hidden="true" /> Copy code{/if}
							</button>
							<button type="button" class={ui.btnGhost} onclick={() => copy(fresh!.link, 'link')}>
								{#if copied === 'link'}<Check class="h-4 w-4" aria-hidden="true" /> Copied{:else}<Copy class="h-4 w-4" aria-hidden="true" /> Copy sign-up link{/if}
							</button>
						</div>
					</div>
				{/if}

				<form class="grid grid-cols-1 gap-4 sm:grid-cols-2" onsubmit={createInvite}>
					<div class="space-y-1.5 sm:col-span-2">
						<label for="inv-note" class={ui.label}>Note <span class="font-normal text-[var(--color-text-tertiary)]">(only you see this)</span></label>
						<input id="inv-note" bind:value={note} maxlength="120" placeholder="e.g. for Ada" class={ui.input} />
					</div>

					<div class="space-y-1.5">
						<label for="inv-uses" class={ui.label}>Number of sign-ups</label>
						<input id="inv-uses" type="number" min="1" max="100" bind:value={maxUses} class={ui.input} />
					</div>

					<div class="space-y-1.5">
						<label for="inv-exp" class={ui.label}>Expires after (days)</label>
						<input id="inv-exp" type="number" min="1" max="365" bind:value={expiresInDays} disabled={neverExpires} class={ui.input} />
						<label class="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
							<input type="checkbox" bind:checked={neverExpires} class="accent-[var(--color-accent)]" /> Never expires
						</label>
					</div>

					<div class="space-y-1.5 sm:col-span-2">
						<label for="inv-quota" class={ui.label}>Storage for the new account</label>
						<div class="flex flex-wrap items-center gap-2">
							<select id="inv-quota" bind:value={quotaMode} class="{ui.input} w-auto min-w-44 cursor-pointer">
								<option value="default">Server default ({quotaText(defaultQuota)})</option>
								<option value="custom">Custom…</option>
								<option value="unlimited">Unlimited</option>
							</select>
							{#if quotaMode === 'custom'}
								<input type="number" min="0" step="0.5" bind:value={quotaGb} aria-label="Storage in GB" class="{ui.input} w-28" />
								<span class="text-sm text-[var(--color-text-tertiary)]">GB</span>
							{/if}
						</div>
					</div>

					<div class="sm:col-span-2">
						<button type="submit" class={ui.btnPrimary} disabled={creating}>
							{#if creating}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Plus class="h-4 w-4" aria-hidden="true" />{/if}
							Create invite
						</button>
					</div>
				</form>
			</section>

			<!-- Invites -->
			<section class="{ui.card} p-5" aria-labelledby="sec-invites">
				<h2 id="sec-invites" class="font-medium">Invites</h2>
				<ul class="mt-3 divide-y divide-[var(--color-border)]">
					{#each invites as inv (inv.id)}
						{@const status = inviteStatus(inv)}
						<li class="flex items-center justify-between gap-3 py-3">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">{inv.note || 'No note'}</p>
								<p class="font-mono-data truncate text-xs text-[var(--color-text-tertiary)]">
									{inv.uses}/{inv.maxUses} used · {inv.quotaBytes === null ? 'default storage' : quotaText(inv.quotaBytes)} · created {timeAgo(inv.createdAt)}{inv.expiresAt && status === 'Active' ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ''}
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<span class="rounded-full px-2 py-0.5 text-xs {status === 'Active' ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'bg-[var(--color-surface-3)] text-[var(--color-text-tertiary)]'}">{status}</span>
								{#if status === 'Active'}
									<button type="button" class={ui.iconBtnDanger} onclick={() => revoke(inv.id)} aria-label="Revoke invite {inv.note ?? ''}" title="Revoke"><Ban class="h-4 w-4" aria-hidden="true" /></button>
								{/if}
							</div>
						</li>
					{:else}
						<li class="py-4 text-sm text-[var(--color-text-tertiary)]">No invites yet.</li>
					{/each}
				</ul>
			</section>

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
