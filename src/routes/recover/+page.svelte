<script lang="ts">
	import { goto } from '$app/navigation';
	import { ShieldCheck, Loader2, KeyRound } from 'lucide-svelte';
	import { importPrivateJwk, wrapPrivateKey } from '$crypto/private-key';
	import { parseRecoveryKey, unwrapPrivateKeyWithRecovery } from '$crypto/recovery';
	import { ui } from '$lib/ui';

	let email = $state('');
	let recoveryKeyInput = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let busy = $state(false);
	let stage = $state<'idle' | 'opening' | 'securing' | 'saving'>('idle');
	let errorMsg = $state<string | null>(null);

	const tooShort = $derived(newPassword.length > 0 && newPassword.length < 12);
	const mismatch = $derived(confirmPassword.length > 0 && newPassword !== confirmPassword);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = null;
		if (newPassword.length < 12) return void (errorMsg = 'New password must be at least 12 characters.');
		if (newPassword !== confirmPassword) return void (errorMsg = 'Passwords do not match.');

		busy = true;
		try {
			const recoveryKey = parseRecoveryKey(recoveryKeyInput);
			const cleanEmail = email.trim().toLowerCase();

			// 1. Fetch the recovery-wrapped key and try to open it with the typed
			// key. Unknown emails get a same-shaped decoy, so this fails with the
			// SAME message either way — nothing here reveals who has an account.
			stage = 'opening';
			const blobRes = await fetch(`/api/auth/recover?email=${encodeURIComponent(cleanEmail)}`);
			if (!blobRes.ok) throw new Error('Could not start recovery — check the email address.');
			const blob = await blobRes.json();
			const { privateKeyJwk, authToken } = await unwrapPrivateKeyWithRecovery(
				blob.recoveryWrappedPrivateKey,
				blob.recoveryIv,
				recoveryKey
			);

			// 2. Re-wrap the SAME private key under the new password. Files stay
			// decryptable because the key itself never changes.
			stage = 'securing';
			const extractable = await importPrivateJwk(privateKeyJwk, blob.keyAlgo, true);
			const wrapped = await wrapPrivateKey(extractable, newPassword);

			// 3. Prove possession of the recovery key (a derived token, not the key)
			// and set the new password.
			stage = 'saving';
			const res = await fetch('/api/auth/recover', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: cleanEmail, recoveryAuthToken: authToken, newPassword, ...wrapped })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? 'Recovery failed');
			}

			await goto('/login?recovered=1');
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Recovery failed';
		} finally {
			busy = false;
			stage = 'idle';
		}
	}
</script>

<svelte:head>
	<title>Recover account — OverDrive</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] px-6 py-12 text-[var(--color-text-primary)]">
	<div class="w-full max-w-sm space-y-6">
		<div class="flex items-center gap-2">
			<ShieldCheck class="h-5 w-5" style="color: var(--color-accent)" aria-hidden="true" />
			<span class="font-semibold tracking-tight">OverDrive</span>
		</div>

		<div>
			<h1 class="text-xl font-semibold tracking-tight">Recover your account</h1>
			<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">
				Enter the recovery key from your recovery kit and choose a new password. Your files stay exactly as they are.
				Two-factor authentication is turned off by recovery — set it up again afterwards.
			</p>
		</div>

		<form class="space-y-4" onsubmit={handleSubmit}>
			<div class="space-y-1.5">
				<label for="email" class={ui.label}>Email</label>
				<input id="email" type="email" required autocomplete="email" bind:value={email} class={ui.input} />
			</div>

			<div class="space-y-1.5">
				<label for="rk" class={ui.label}>Recovery key</label>
				<textarea
					id="rk"
					required
					rows="3"
					spellcheck="false"
					autocomplete="off"
					autocapitalize="characters"
					placeholder="ABCD-EFGH-IJKL-…"
					bind:value={recoveryKeyInput}
					class="{ui.input} {ui.mono} h-auto resize-none py-2.5 tracking-wider"
				></textarea>
			</div>

			<div class="space-y-1.5">
				<label for="np" class={ui.label}>New password</label>
				<input id="np" type="password" required minlength="12" autocomplete="new-password" bind:value={newPassword} class={ui.input} />
				<p class="text-xs" style="color: {tooShort ? 'var(--color-danger)' : 'var(--color-text-tertiary)'}">At least 12 characters.</p>
			</div>

			<div class="space-y-1.5">
				<label for="cp" class={ui.label}>Confirm new password</label>
				<input
					id="cp"
					type="password"
					required
					autocomplete="new-password"
					bind:value={confirmPassword}
					class={ui.input}
					style="border-color: {mismatch ? 'var(--color-danger)' : ''}"
				/>
			</div>

			{#if errorMsg}
				<div class={ui.alertDanger} role="alert">{errorMsg}</div>
			{/if}

			<button type="submit" disabled={busy} class="{ui.btnPrimary} h-11 w-full">
				{#if busy}
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					{stage === 'opening' ? 'Opening recovery key…' : stage === 'securing' ? 'Securing your key…' : 'Saving…'}
				{:else}
					<KeyRound class="h-4 w-4" aria-hidden="true" /> Reset password
				{/if}
			</button>
		</form>

		<p class="text-center text-sm text-[var(--color-text-tertiary)]">
			Remembered it? <a href="/login" class="underline" style="color: var(--color-accent)">Sign in</a>
		</p>
	</div>
</div>
