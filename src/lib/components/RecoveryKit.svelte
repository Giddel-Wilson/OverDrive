<script lang="ts">
	import { Copy, Download, Printer, Check, ShieldAlert } from 'lucide-svelte';
	import { ui } from '$lib/ui';
	import { recoveryKitText } from '$crypto/recovery';
	import { triggerBrowserDownload } from '$crypto/download-pipeline';

	let {
		email,
		recoveryKey,
		doneLabel = 'Continue',
		onDone
	}: {
		email: string;
		/** The formatted key, e.g. ABCD-EFGH-… (13 groups). */
		recoveryKey: string;
		doneLabel?: string;
		onDone: () => void;
	} = $props();

	let copied = $state(false);
	let saved = $state(false);

	const groups = $derived(recoveryKey.split('-'));

	function download() {
		triggerBrowserDownload(
			new Blob([recoveryKitText(email, recoveryKey)], { type: 'text/plain' }),
			'endtoend-encrypt-recovery-kit.txt'
		);
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(recoveryKey);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			/* clipboard blocked — the key is on screen and in the download */
		}
	}

	const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

	function print() {
		const w = window.open('', '_blank', 'width=760,height=900');
		if (!w) return;
		w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>EndToEnd Encrypt — Recovery Kit</title></head>
<body style="font-family: system-ui, sans-serif; padding: 48px; max-width: 640px; line-height: 1.5; color: #111">
<h1 style="font-size: 22px; margin: 0 0 4px">EndToEnd Encrypt — Recovery Kit</h1>
<p style="margin: 0 0 28px; color: #555">Keep this page somewhere safe and offline.</p>
<p style="margin: 0 0 4px"><strong>Account:</strong> ${esc(email)}</p>
<p style="margin: 0 0 8px"><strong>Recovery key:</strong></p>
<p style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 20px; letter-spacing: 1px; padding: 16px; border: 2px solid #111; border-radius: 8px; word-spacing: 6px">${esc(recoveryKey.replaceAll('-', ' - '))}</p>
<p style="margin-top: 28px"><strong>If you forget your password</strong>, this key is the only way back into your files — we cannot reset it for you. On the sign-in page choose “Forgot password”, then enter your email, this key and a new password.</p>
<p><strong>Anyone with this key and your email can take over your account.</strong> Don't store it inside the vault. Creating a new key in Account settings makes this one stop working.</p>
<p style="color: #555; font-size: 12px">Created ${new Date().toISOString().slice(0, 10)}</p>
</body></html>`);
		w.document.close();
		w.focus();
		w.print();
	}
</script>

<div class="space-y-5">
	<div class="flex items-start gap-3 {ui.alertInfo}">
		<ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
		<p>
			This is the <strong class="text-[var(--color-text-primary)]">only</strong> way to get your files back if you forget your
			password — we can't reset it for you. It is shown once and never stored in a form we can read.
		</p>
	</div>

	<div class="rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4">
		<p class="mb-3 text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">Recovery key</p>
		<div class="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-4" aria-label="Recovery key">
			{#each groups as group, i (i)}
				<span class="{ui.mono} text-base tracking-wider text-[var(--color-text-primary)]">{group}</span>
			{/each}
		</div>
	</div>

	<div class="flex flex-wrap gap-2">
		<button type="button" class={ui.btnGhost} onclick={copy}>
			{#if copied}<Check class="h-4 w-4" aria-hidden="true" /> Copied{:else}<Copy class="h-4 w-4" aria-hidden="true" /> Copy{/if}
		</button>
		<button type="button" class={ui.btnGhost} onclick={download}>
			<Download class="h-4 w-4" aria-hidden="true" /> Download .txt
		</button>
		<button type="button" class={ui.btnGhost} onclick={print}>
			<Printer class="h-4 w-4" aria-hidden="true" /> Print
		</button>
	</div>

	<label class="flex cursor-pointer items-start gap-2.5 text-sm text-[var(--color-text-secondary)]">
		<input type="checkbox" bind:checked={saved} class="mt-0.5 h-4 w-4 cursor-pointer accent-[var(--color-accent)]" />
		I've saved this key somewhere safe (printed, or in a password manager — not in this vault).
	</label>

	<button type="button" class="{ui.btnPrimary} w-full" disabled={!saved} onclick={onDone}>{doneLabel}</button>
</div>
