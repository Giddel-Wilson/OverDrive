<script lang="ts">
	import { KeyRound, Loader2, ShieldCheck, ShieldAlert } from 'lucide-svelte';
	import Modal from './Modal.svelte';
	import RecoveryKit from './RecoveryKit.svelte';
	import { ui } from '$lib/ui';
	import { unwrapPrivateKeyJwk } from '$crypto/private-key';
	import { formatRecoveryKey, generateRecoveryKey, wrapPrivateKeyWithRecovery } from '$crypto/recovery';

	let {
		email,
		hasRecoveryKey,
		onChanged
	}: { email: string; hasRecoveryKey: boolean; onChanged: () => void } = $props();

	let askOpen = $state(false);
	let password = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	let kit = $state<string | null>(null);

	function openAsk() {
		password = '';
		errorMsg = null;
		askOpen = true;
	}

	async function generate(e: Event) {
		e.preventDefault();
		errorMsg = null;
		busy = true;
		try {
			// The unlocked key in memory isn't extractable, so re-open the
			// password-wrapped copy to get the JWK that the recovery key will wrap.
			const keysRes = await fetch('/api/auth/keys');
			if (!keysRes.ok) throw new Error('Could not load your key material');
			const user = await keysRes.json();
			const jwk = await unwrapPrivateKeyJwk(user.wrappedPrivateKey, user.wrappedPrivateKeyIv, password, user.privateKeyKdfParams);

			const recoveryKey = generateRecoveryKey();
			const wrapped = await wrapPrivateKeyWithRecovery(jwk, recoveryKey);

			const res = await fetch('/api/auth/recovery-key', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword: password, ...wrapped })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? 'Could not save the recovery key');
			}

			askOpen = false;
			password = '';
			kit = formatRecoveryKey(recoveryKey);
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Something went wrong';
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-4">
	{#if hasRecoveryKey}
		<p class="flex items-center gap-2 text-sm text-[var(--color-accent)]">
			<ShieldCheck class="h-4 w-4" aria-hidden="true" /> A recovery key is set up for this account.
		</p>
	{:else}
		<div class="flex items-start gap-2 {ui.alertDanger}">
			<ShieldAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<p>No recovery key yet. If you forget your password, your files cannot be recovered — create one now.</p>
		</div>
	{/if}

	<button type="button" class={ui.btnGhost} onclick={openAsk}>
		<KeyRound class="h-4 w-4" aria-hidden="true" />
		{hasRecoveryKey ? 'Replace recovery key' : 'Create recovery key'}
	</button>
	{#if hasRecoveryKey}
		<p class="text-xs text-[var(--color-text-tertiary)]">Replacing it makes your old recovery key stop working.</p>
	{/if}
</div>

<Modal open={askOpen} title="Confirm your password" onClose={() => (askOpen = false)} size="sm">
	<form class="space-y-4" onsubmit={generate}>
		<p class="text-sm text-[var(--color-text-secondary)]">
			Your password is needed to re-open your private key so it can be locked under the new recovery key. Nothing leaves your browser except
			ciphertext.
		</p>
		<div class="space-y-1.5">
			<label for="rk-pw" class={ui.label}>Current password</label>
			<input id="rk-pw" type="password" required autocomplete="current-password" bind:value={password} class={ui.input} />
		</div>
		{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
		<div class="flex justify-end gap-2">
			<button type="button" class={ui.btnGhost} onclick={() => (askOpen = false)} disabled={busy}>Cancel</button>
			<button type="submit" class={ui.btnPrimary} disabled={busy || password.length === 0}>
				{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
				Generate key
			</button>
		</div>
	</form>
</Modal>

<Modal open={kit !== null} title="Your new recovery key" onClose={() => {}} size="md" dismissable={false}>
	{#if kit}
		<RecoveryKit
			{email}
			recoveryKey={kit}
			doneLabel="Done"
			onDone={() => {
				kit = null;
				onChanged();
			}}
		/>
	{/if}
</Modal>
