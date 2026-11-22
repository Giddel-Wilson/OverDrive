<script lang="ts">
	import QRCode from 'qrcode';
	import { Loader2, ShieldCheck, Smartphone } from 'lucide-svelte';
	import { ui } from '$lib/ui';

	let { enabled, onChanged }: { enabled: boolean; onChanged: (enabled: boolean) => void } = $props();

	let stage = $state<'idle' | 'setup' | 'disable'>('idle');
	let secret = $state('');
	let qrSvg = $state('');
	let code = $state('');
	let password = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	async function post(body: unknown) {
		const res = await fetch('/api/auth/2fa', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.message ?? 'Request failed');
		return data;
	}

	async function startSetup() {
		errorMsg = null;
		busy = true;
		try {
			const data = await post({ action: 'setup' });
			secret = data.secret;
			// Generated locally from the otpauth URI — the secret is not sent to any QR service.
			// Leave room for the card's 4px inset so the SVG fits inside its rounded edge.
			qrSvg = await QRCode.toString(data.otpauthUri, { type: 'svg', margin: 1, width: 184 });
			code = '';
			stage = 'setup';
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Could not start setup';
		} finally {
			busy = false;
		}
	}

	async function confirmEnable(e: Event) {
		e.preventDefault();
		errorMsg = null;
		busy = true;
		try {
			await post({ action: 'enable', code: code.trim() });
			stage = 'idle';
			secret = '';
			qrSvg = '';
			onChanged(true);
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Could not enable two-factor';
		} finally {
			busy = false;
		}
	}

	async function confirmDisable(e: Event) {
		e.preventDefault();
		errorMsg = null;
		busy = true;
		try {
			await post({ action: 'disable', password, code: code.trim() });
			stage = 'idle';
			password = '';
			code = '';
			onChanged(false);
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Could not turn off two-factor';
		} finally {
			busy = false;
		}
	}

	function cancel() {
		stage = 'idle';
		errorMsg = null;
		code = '';
		password = '';
	}
</script>

<div class="space-y-4">
	{#if stage === 'idle'}
		{#if enabled}
			<p class="flex items-center gap-2 text-sm text-[var(--color-accent)]">
				<ShieldCheck class="h-4 w-4" aria-hidden="true" /> Two-factor authentication is on.
			</p>
			<button type="button" class={ui.btnGhost} onclick={() => ((stage = 'disable'), (code = ''), (password = ''), (errorMsg = null))}>
				Turn off
			</button>
		{:else}
			<p class="text-sm text-[var(--color-text-secondary)]">
				Require a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…) in addition to your password.
				If you lose the app, your recovery key turns it off again.
			</p>
			<button type="button" class={ui.btnGhost} onclick={startSetup} disabled={busy}>
				{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Smartphone class="h-4 w-4" aria-hidden="true" />{/if}
				Set up two-factor
			</button>
		{/if}
	{:else if stage === 'setup'}
		<form class="space-y-4" onsubmit={confirmEnable}>
			<ol class="list-decimal space-y-1 pl-5 text-sm text-[var(--color-text-secondary)]">
				<li>Scan this QR code with your authenticator app.</li>
				<li>Enter the 6-digit code it shows to finish.</li>
			</ol>
			<div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
				<!-- Library-generated SVG from a locally built string, not user input. -->
				<div class="h-48 w-48 shrink-0 overflow-hidden rounded-[var(--radius-md)] bg-white p-1">{@html qrSvg}</div>
				<div class="min-w-0 space-y-1 text-xs text-[var(--color-text-tertiary)]">
					<p>Can't scan? Enter this key manually:</p>
					<p class="{ui.mono} break-all text-sm tracking-wider text-[var(--color-text-primary)]">{secret}</p>
				</div>
			</div>
			<div class="space-y-1.5">
				<label for="tf-code" class={ui.label}>6-digit code</label>
				<input
					id="tf-code"
					inputmode="numeric"
					autocomplete="one-time-code"
					pattern="[0-9]{6}"
					maxlength="6"
					required
					bind:value={code}
					class="{ui.input} {ui.mono} max-w-48 tracking-[0.3em]"
				/>
			</div>
			{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
			<div class="flex gap-2">
				<button type="button" class={ui.btnGhost} onclick={cancel} disabled={busy}>Cancel</button>
				<button type="submit" class={ui.btnPrimary} disabled={busy || code.length !== 6}>
					{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
					Turn on
				</button>
			</div>
		</form>
	{:else}
		<form class="space-y-4" onsubmit={confirmDisable}>
			<p class="text-sm text-[var(--color-text-secondary)]">Confirm with both factors to turn two-factor off.</p>
			<div class="space-y-1.5">
				<label for="tf-pw" class={ui.label}>Password</label>
				<input id="tf-pw" type="password" required autocomplete="current-password" bind:value={password} class={ui.input} />
			</div>
			<div class="space-y-1.5">
				<label for="tf-code2" class={ui.label}>6-digit code</label>
				<input
					id="tf-code2"
					inputmode="numeric"
					autocomplete="one-time-code"
					pattern="[0-9]{6}"
					maxlength="6"
					required
					bind:value={code}
					class="{ui.input} {ui.mono} max-w-48 tracking-[0.3em]"
				/>
			</div>
			{#if errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
			<div class="flex gap-2">
				<button type="button" class={ui.btnGhost} onclick={cancel} disabled={busy}>Cancel</button>
				<button type="submit" class={ui.btnDanger} disabled={busy || code.length !== 6 || password.length === 0}>
					{#if busy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
					Turn off
				</button>
			</div>
		</form>
	{/if}

	{#if stage === 'idle' && errorMsg}<div class={ui.alertDanger} role="alert">{errorMsg}</div>{/if}
</div>
