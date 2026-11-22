<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2, CheckCircle2 } from 'lucide-svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import RecoveryKeySettings from '$lib/components/RecoveryKeySettings.svelte';
	import TwoFactorSettings from '$lib/components/TwoFactorSettings.svelte';
	import ExportVault from '$lib/components/ExportVault.svelte';
	import SessionsSettings from '$lib/components/SessionsSettings.svelte';
	import StorageMeter, { type Usage } from '$lib/components/StorageMeter.svelte';
	import { ui } from '$lib/ui';
	import { reWrapPrivateKeyWithNewPassword, unwrapPrivateKey } from '$crypto/private-key';
	import { keyStore } from '$lib/stores/key-store.svelte';

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	let success = $state(false);

	// Account facts (booleans only — never the secrets themselves).
	let loaded = $state(false);
	let hasRecoveryKey = $state(false);
	let totpEnabled = $state(false);
	let email = $state('');
	let usage = $state<Usage | null>(null);

	async function loadAccount() {
		const [keysRes, meRes, usageRes] = await Promise.all([fetch('/api/auth/keys'), fetch('/api/auth/me'), fetch('/api/storage')]);
		if (usageRes.ok) usage = await usageRes.json();
		if (keysRes.ok) {
			const k = await keysRes.json();
			hasRecoveryKey = k.hasRecoveryKey;
			totpEnabled = k.totpEnabled;
		}
		if (meRes.ok) email = (await meRes.json()).email ?? '';
		loaded = true;
	}
	onMount(loadAccount);

	const tooShort = $derived(newPassword.length > 0 && newPassword.length < 12);
	const mismatch = $derived(confirmPassword.length > 0 && newPassword !== confirmPassword);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = null;
		success = false;

		if (newPassword.length < 12) {
			errorMsg = 'New password must be at least 12 characters.';
			return;
		}
		if (newPassword !== confirmPassword) {
			errorMsg = 'New passwords do not match.';
			return;
		}

		busy = true;
		try {
			const keysRes = await fetch('/api/auth/keys');
			if (!keysRes.ok) throw new Error('Could not load your current key material');
			const user = await keysRes.json();

			const rewrapped = await reWrapPrivateKeyWithNewPassword(
				user.wrappedPrivateKey,
				user.wrappedPrivateKeyIv,
				currentPassword,
				user.privateKeyKdfParams,
				newPassword,
				user.keyAlgo
			);

			const changeRes = await fetch('/api/auth/change-password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword, newPassword, ...rewrapped })
			});
			if (!changeRes.ok) {
				const body = await changeRes.json().catch(() => ({}));
				throw new Error(body.message ?? 'Failed to change password');
			}

			// Re-unlock with the new password so the session stays usable
			// without forcing a fresh sign-in.
			const privateKey = await unwrapPrivateKey(
				rewrapped.wrappedPrivateKey,
				rewrapped.wrappedPrivateKeyIv,
				newPassword,
				rewrapped.privateKeyKdfParams,
				user.keyAlgo
			);
			keyStore.set({
				privateKey,
				publicKey: keyStore.publicKey,
				publicKeyJwk: keyStore.publicKeyJwk,
				keyAlgo: keyStore.keyAlgo
			});

			success = true;
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Failed to change password';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Account — OverDrive</title>
</svelte:head>

<div class="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text-primary)]">
	<AppHeader />

	<main class="mx-auto max-w-2xl space-y-6 px-6 py-10">
		<div>
			<h1 class="text-xl font-semibold tracking-tight">Account</h1>
			<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">Recovery, sign-in security, backups and your password.</p>
		</div>

		<section class="{ui.card} space-y-3 p-5" aria-labelledby="sec-storage">
			<h2 id="sec-storage" class="font-medium">Storage</h2>
			{#if usage}
				<StorageMeter {usage} />
			{:else}
				<Loader2 class="h-4 w-4 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
			{/if}
		</section>

		<section class="{ui.card} space-y-3 p-5" aria-labelledby="sec-recovery">
			<h2 id="sec-recovery" class="font-medium">Recovery key</h2>
			{#if loaded}
				<RecoveryKeySettings {email} {hasRecoveryKey} onChanged={() => (hasRecoveryKey = true)} />
			{:else}
				<Loader2 class="h-4 w-4 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
			{/if}
		</section>

		<section class="{ui.card} space-y-3 p-5" aria-labelledby="sec-2fa">
			<h2 id="sec-2fa" class="font-medium">Two-factor authentication</h2>
			{#if loaded}
				<TwoFactorSettings enabled={totpEnabled} onChanged={(v) => (totpEnabled = v)} />
			{:else}
				<Loader2 class="h-4 w-4 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
			{/if}
		</section>

		<section class="{ui.card} space-y-3 p-5" aria-labelledby="sec-sessions">
			<h2 id="sec-sessions" class="font-medium">Devices &amp; sessions</h2>
			<SessionsSettings />
		</section>

		<section class="{ui.card} space-y-3 p-5" aria-labelledby="sec-export">
			<h2 id="sec-export" class="font-medium">Export your vault</h2>
			<ExportVault />
		</section>

		<section class="{ui.card} p-5" aria-labelledby="sec-password">
			<h2 id="sec-password" class="font-medium">Change password</h2>
			<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">
				Your password protects both your login and your private key. Changing it also signs out your other devices. It re-encrypts your private key with the new password — entirely
				in your browser. Your recovery key keeps working.
			</p>

			<form class="mt-5 space-y-4" onsubmit={handleSubmit}>
				<div class="space-y-1.5">
					<label for="current" class={ui.label}>Current password</label>
					<input id="current" type="password" required autocomplete="current-password" bind:value={currentPassword} class={ui.input} />
				</div>

				<div class="space-y-1.5">
					<label for="new" class={ui.label}>New password</label>
					<input
						id="new"
						type="password"
						required
						minlength="12"
						autocomplete="new-password"
						bind:value={newPassword}
						class={ui.input}
						style="border-color: {tooShort ? 'var(--color-danger)' : ''}"
					/>
				</div>

				<div class="space-y-1.5">
					<label for="confirm" class={ui.label}>Confirm new password</label>
					<input
						id="confirm"
						type="password"
						required
						autocomplete="new-password"
						bind:value={confirmPassword}
						class={ui.input}
						style="border-color: {mismatch ? 'var(--color-danger)' : ''}"
					/>
				</div>

				{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}

				{#if success}
					<div class="flex items-center gap-2 {ui.alertOk}">
						<CheckCircle2 class="h-4 w-4" aria-hidden="true" />
						Password changed.
					</div>
				{/if}

				<button type="submit" disabled={busy} class="{ui.btnPrimary} h-11 w-full">
					{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
					Change password
				</button>
			</form>
		</section>
	</main>
</div>
