<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ShieldCheck, Loader2 } from 'lucide-svelte';
	import { unwrapPrivateKey, importPublicKey } from '$crypto/private-key';
	import { keyStore } from '$lib/stores/key-store.svelte';
	import { ui } from '$lib/ui';

	let email = $state('');
	let password = $state('');
	let totp = $state('');
	let needsCode = $state(false);
	let busy = $state(false);
	let stage = $state<'idle' | 'authenticating' | 'unlocking'>('idle');
	let errorMsg = $state<string | null>(null);

	const recovered = $derived(page.url.searchParams.get('recovered') === '1');

	async function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = null;
		busy = true;
		try {
			stage = 'authenticating';
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password, ...(needsCode ? { totp: totp.trim() } : {}) })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? 'Invalid email or password');
			}
			const user = await res.json();

			// Password was right and the account has 2FA: nothing else has been
			// released yet — ask for the code and resubmit.
			if (user.twoFactorRequired) {
				needsCode = true;
				return;
			}

			// Re-derive the wrapping key from the password the user just
			// typed and unlock the private key — entirely in-browser, the
			// server response only ever contained ciphertext.
			stage = 'unlocking';
			const privateKey = await unwrapPrivateKey(
				user.wrappedPrivateKey,
				user.wrappedPrivateKeyIv,
				password,
				user.privateKeyKdfParams,
				user.keyAlgo
			);
			const publicKey = await importPublicKey(user.publicKeyJwk, user.keyAlgo);

			keyStore.set({ privateKey, publicKey, publicKeyJwk: user.publicKeyJwk, keyAlgo: user.keyAlgo });

			await goto('/dashboard');
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Sign in failed';
		} finally {
			busy = false;
			stage = 'idle';
		}
	}
</script>

<svelte:head>
	<title>Sign in — EndToEnd Encrypt</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] px-6 py-12 text-[var(--color-text-primary)]">
	<div class="w-full max-w-sm space-y-6">
		<div class="flex items-center gap-2">
			<ShieldCheck class="h-5 w-5" style="color: var(--color-accent)" aria-hidden="true" />
			<span class="font-semibold tracking-tight">EndToEnd Encrypt</span>
		</div>

		<div>
			<h1 class="text-xl font-semibold tracking-tight">Welcome back</h1>
			<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">
				Your password is checked by the server over TLS, then unlocks your private key locally in this browser. We never store it.
			</p>
		</div>

		{#if recovered}
			<div class={ui.alertOk} role="status">Password reset. Sign in with your new password — your files are untouched.</div>
		{/if}

		<form class="space-y-4" onsubmit={handleSubmit}>
			<div class="space-y-1.5">
				<label for="email" class={ui.label}>Email</label>
				<input id="email" type="email" required autocomplete="email" bind:value={email} disabled={needsCode && busy} class={ui.input} />
			</div>

			<div class="space-y-1.5">
				<label for="password" class={ui.label}>Password</label>
				<input id="password" type="password" required autocomplete="current-password" bind:value={password} class={ui.input} />
			</div>

			{#if needsCode}
				<div class="space-y-1.5">
					<label for="totp" class={ui.label}>Authentication code</label>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						id="totp"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern="[0-9]{6}"
						maxlength="6"
						required
						autofocus
						placeholder="6-digit code"
						bind:value={totp}
						class="{ui.input} {ui.mono} tracking-[0.3em]"
					/>
					<p class="text-xs text-[var(--color-text-tertiary)]">From your authenticator app.</p>
				</div>
			{/if}

			{#if errorMsg}
				<div class={ui.alertDanger} role="alert">{errorMsg}</div>
			{/if}

			<button type="submit" disabled={busy} class="{ui.btnPrimary} h-11 w-full">
				{#if busy}
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					{stage === 'authenticating' ? 'Signing in…' : 'Unlocking key…'}
				{:else}
					{needsCode ? 'Verify and sign in' : 'Sign in'}
				{/if}
			</button>
		</form>

		<div class="space-y-1 text-center text-sm text-[var(--color-text-tertiary)]">
			<p><a href="/recover" class="underline" style="color: var(--color-accent)">Forgot password?</a> Use your recovery key.</p>
			<p>Need an account? <a href="/register" class="underline" style="color: var(--color-accent)">Create one</a></p>
		</div>
	</div>
</div>
