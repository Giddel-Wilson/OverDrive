<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ShieldCheck, Loader2 } from 'lucide-svelte';
	import { generateRsaKeypair, generateEcdhKeypair } from '$crypto/key-encryption';
	import { wrapPrivateKey } from '$crypto/private-key';
	import { formatRecoveryKey, generateRecoveryKey, wrapPrivateKeyWithRecovery } from '$crypto/recovery';
	import { keyStore } from '$lib/stores/key-store.svelte';
	import RecoveryKit from '$lib/components/RecoveryKit.svelte';
	import type { KeyAlgo } from '$crypto/types';

	let email = $state('');
	let displayName = $state('');
	// Sign-up policy from the server: 'open', 'invite' (the default) or 'closed'.
	let mode = $state<'loading' | 'open' | 'invite' | 'closed'>('loading');
	let bootstrap = $state(false);
	let inviteCode = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let keyAlgo = $state<KeyAlgo>('RSA-OAEP');
	let busy = $state(false);
	let stage = $state<'idle' | 'generating-keys' | 'wrapping' | 'submitting'>('idle');
	let errorMsg = $state<string | null>(null);
	// Set after a successful sign-up: the one-time recovery kit the user must acknowledge.
	let kit = $state<{ email: string; key: string } | null>(null);

	onMount(async () => {
		// An invite link looks like /register?invite=XXXX-XXXX-XXXX-XXXX
		inviteCode = page.url.searchParams.get('invite') ?? '';
		try {
			const res = await fetch('/api/auth/registration');
			const info = await res.json();
			mode = info.mode;
			bootstrap = info.bootstrap;
		} catch {
			mode = 'invite'; // can't tell — the server decides anyway
		}
	});

	const passwordTooShort = $derived(password.length > 0 && password.length < 12);
	const passwordsMismatch = $derived(confirmPassword.length > 0 && password !== confirmPassword);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = null;

		if (password.length < 12) {
			errorMsg = 'Password must be at least 12 characters.';
			return;
		}
		if (password !== confirmPassword) {
			errorMsg = 'Passwords do not match.';
			return;
		}

		busy = true;
		try {
			// 1. Generate the keypair entirely in-browser.
			stage = 'generating-keys';
			const keypair = keyAlgo === 'RSA-OAEP' ? await generateRsaKeypair() : await generateEcdhKeypair();
			const publicKeyJwk = await crypto.subtle.exportKey('jwk', keypair.publicKey);

			// 2. Wrap the private key with a key derived (Argon2id) from the
			// same password — this derivation never leaves the browser.
			stage = 'wrapping';
			const wrapped = await wrapPrivateKey(keypair.privateKey, password);

			// 2b. A second copy of the private key, locked under a random
			// recovery key shown to the user once. It's the only way back in
			// if the password is forgotten; the server only ever receives the
			// ciphertext and a proof token derived from the key.
			const recoveryKey = generateRecoveryKey();
			const recovery = await wrapPrivateKeyWithRecovery(
				await crypto.subtle.exportKey('jwk', keypair.privateKey),
				recoveryKey
			);

			// 3. Submit auth credentials + already-wrapped key material.
			stage = 'submitting';
			const res = await fetch('/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email,
					displayName,
					password,
					publicKeyJwk,
					keyAlgo,
					...wrapped,
					...recovery,
					...(mode === 'invite' && inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {})
				})
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? 'Registration failed');
			}

			// Keep the freshly-generated keypair unlocked for this tab so the
			// user can start uploading immediately without re-entering their
			// password.
			keyStore.set({ privateKey: keypair.privateKey, publicKey: keypair.publicKey, publicKeyJwk, keyAlgo });

			// Don't leave yet — show the recovery kit first.
			kit = { email, key: formatRecoveryKey(recoveryKey) };
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Something went wrong';
		} finally {
			busy = false;
			stage = 'idle';
		}
	}
</script>

<svelte:head>
	<title>Create account — EndToEnd Encrypt</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] px-6 py-12 text-[var(--color-text-primary)]">
	<div class="w-full max-w-sm space-y-6">
		<div class="flex items-center gap-2">
			<ShieldCheck class="h-5 w-5" style="color: var(--color-accent)" aria-hidden="true" />
			<span class="font-semibold tracking-tight">EndToEnd Encrypt</span>
		</div>

		{#if kit}
			<div>
				<h1 class="text-xl font-semibold tracking-tight">Save your recovery key</h1>
				<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">Your vault is ready. One last step before you start.</p>
			</div>
			<RecoveryKit email={kit.email} recoveryKey={kit.key} doneLabel="Continue to my vault" onDone={() => goto('/dashboard')} />
		{:else if mode === 'closed'}
			<div class="space-y-3">
				<h1 class="text-xl font-semibold tracking-tight">Sign-ups are closed</h1>
				<p class="text-sm text-[var(--color-text-tertiary)]">This server isn't accepting new accounts right now.</p>
				<a href="/login" class="inline-block text-sm underline" style="color: var(--color-accent)">Sign in instead</a>
			</div>
		{:else}
		<div>
			<h1 class="text-xl font-semibold tracking-tight">{bootstrap ? 'Create the first account' : 'Create your vault'}</h1>
			<p class="mt-1 text-sm text-[var(--color-text-tertiary)]">
				Your private key is generated and locked in your browser, using a key derived from your password. We never see it.
				The password itself is sent over TLS only so we can check it at sign-in — it is never stored.
			</p>
		</div>

		<form class="space-y-4" onsubmit={handleSubmit}>
			{#if bootstrap}
				<div class="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2.5 text-sm text-[var(--color-text-secondary)]">
					No accounts exist yet, so this one is open to anyone. Use the email listed in <span class="font-mono-data">ADMIN_EMAILS</span> to
					become the admin.
				</div>
			{/if}
			{#if mode === 'invite'}
				<div class="space-y-1.5">
					<label for="invite" class="text-sm font-medium text-[var(--color-text-secondary)]">Invite code</label>
					<input
						id="invite"
						required
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
						placeholder="XXXX-XXXX-XXXX-XXXX"
						bind:value={inviteCode}
						class="font-mono-data h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm tracking-wider outline-none focus:border-[var(--color-accent)]"
					/>
					<p class="text-xs text-[var(--color-text-tertiary)]">Sign-up is by invitation. Ask the person who runs this vault for a code.</p>
				</div>
			{/if}
			<div class="space-y-1.5">
				<label for="email" class="text-sm font-medium text-[var(--color-text-secondary)]">Email</label>
				<input
					id="email"
					type="email"
					required
					bind:value={email}
					class="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
				/>
			</div>

			<div class="space-y-1.5">
				<label for="displayName" class="text-sm font-medium text-[var(--color-text-secondary)]">Display name</label>
				<input
					id="displayName"
					type="text"
					bind:value={displayName}
					class="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
				/>
			</div>

			<div class="space-y-1.5">
				<label for="password" class="text-sm font-medium text-[var(--color-text-secondary)]">Password</label>
				<input
					id="password"
					type="password"
					required
					minlength="12"
					bind:value={password}
					aria-describedby="password-help"
					class="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
				/>
				<p id="password-help" class="text-xs" style="color: {passwordTooShort ? 'var(--color-danger)' : 'var(--color-text-tertiary)'}">
					At least 12 characters. This also protects your encryption key, so make it a real one.
				</p>
			</div>

			<div class="space-y-1.5">
				<label for="confirmPassword" class="text-sm font-medium text-[var(--color-text-secondary)]">Confirm password</label>
				<input
					id="confirmPassword"
					type="password"
					required
					bind:value={confirmPassword}
					class="h-11 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 text-sm outline-none"
					style="border-color: {passwordsMismatch ? 'var(--color-danger)' : 'var(--color-border)'}"
				/>
			</div>

			<fieldset class="space-y-2">
				<legend class="text-sm font-medium text-[var(--color-text-secondary)]">Key type</legend>
				<div class="flex gap-2" role="radiogroup" aria-label="Key algorithm">
					{#each ['RSA-OAEP', 'ECDH-P256'] as algo (algo)}
						<button
							type="button"
							role="radio"
							aria-checked={keyAlgo === algo}
							onclick={() => (keyAlgo = algo as KeyAlgo)}
							class="min-h-11 flex-1 rounded-[var(--radius-md)] border px-3 py-2 text-sm font-mono-data cursor-pointer transition-colors duration-150"
							style="
								border-color: {keyAlgo === algo ? 'var(--color-accent)' : 'var(--color-border)'};
								background: {keyAlgo === algo ? 'var(--color-accent-bg)' : 'var(--color-surface-2)'};
								color: {keyAlgo === algo ? 'var(--color-accent)' : 'var(--color-text-secondary)'};
							"
						>
							{algo === 'ECDH-P256' ? 'ECDH (P-256)' : 'RSA-OAEP (4096)'}
						</button>
					{/each}
				</div>
			</fieldset>

			{#if errorMsg}
				<div
					class="rounded-[var(--radius-md)] border px-3 py-2.5 text-sm"
					style="border-color: var(--color-danger); background: var(--color-danger-bg); color: var(--color-danger);"
					role="alert"
				>
					{errorMsg}
				</div>
			{/if}

			<button
				type="submit"
				disabled={busy}
				class="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] font-medium cursor-pointer transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-60"
				style="background: var(--color-accent); color: var(--color-bg);"
			>
				{#if busy}
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					{stage === 'generating-keys' ? 'Generating keypair…' : stage === 'wrapping' ? 'Securing private key…' : 'Creating account…'}
				{:else}
					Create vault
				{/if}
			</button>
		</form>

		<p class="text-center text-sm text-[var(--color-text-tertiary)]">
			Already have an account? <a href="/login" class="underline" style="color: var(--color-accent)">Sign in</a>
		</p>
		{/if}
	</div>
</div>
