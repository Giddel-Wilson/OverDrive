<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { ShieldCheck, Menu, LogOut, Vault, ScrollText, KeyRound, UserRound, Users, Link2 } from 'lucide-svelte';
	import BottomSheet from './BottomSheet.svelte';
	import { keyStore } from '$lib/stores/key-store.svelte';

	const baseLinks = [
		{ href: '/dashboard', label: 'Vault', icon: Vault },
		{ href: '/dashboard/shares', label: 'Links', icon: Link2 },
		{ href: '/dashboard/logs', label: 'Access logs', icon: ScrollText },
		{ href: '/settings/keys', label: 'Keys', icon: KeyRound },
		{ href: '/settings/account', label: 'Account', icon: UserRound }
	];

	// The Admin link only appears for accounts listed in ADMIN_EMAILS.
	let isAdmin = $state(false);
	onMount(async () => {
		try {
			const res = await fetch('/api/auth/me');
			if (res.ok) isAdmin = (await res.json()).isAdmin === true;
		} catch {
			/* no admin link — harmless */
		}
	});
	const links = $derived(isAdmin ? [...baseLinks, { href: '/settings/admin', label: 'Admin', icon: Users }] : baseLinks);

	let menuOpen = $state(false);

	async function signOut() {
		menuOpen = false;
		keyStore.lock();
		await fetch('/api/auth/logout', { method: 'POST' });
		await goto('/login');
	}

	// Close the sheet whenever the route changes.
	$effect(() => {
		void page.url.pathname;
		menuOpen = false;
	});

	// The sheet is mobile-only: if the window grows to desktop width, close it
	// so the page behind isn't left frozen.
	$effect(() => {
		const wide = window.matchMedia('(min-width: 768px)');
		const close = () => wide.matches && (menuOpen = false);
		wide.addEventListener('change', close);
		return () => wide.removeEventListener('change', close);
	});
</script>

<header class="border-b border-[var(--color-border)]">
	<div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
		<a href="/dashboard" class="flex items-center gap-2">
			<ShieldCheck class="h-5 w-5" style="color: var(--color-accent)" aria-hidden="true" />
			<span class="font-semibold tracking-tight">EndToEnd Encrypt</span>
		</a>

		<!-- Desktop / tablet navigation -->
		<nav class="hidden items-center gap-4 text-sm text-[var(--color-text-secondary)] md:flex" aria-label="Main">
			{#each links as link (link.href)}
				<a
					href={link.href}
					class="hover:text-[var(--color-text-primary)]"
					style={page.url.pathname === link.href ? 'color: var(--color-text-primary)' : ''}
					aria-current={page.url.pathname === link.href ? 'page' : undefined}
				>
					{link.label}
				</a>
			{/each}
			<button type="button" class="cursor-pointer hover:text-[var(--color-text-primary)]" onclick={signOut}>Sign out</button>
		</nav>

		<!-- Mobile: opens the bottom sheet -->
		<button
			type="button"
			class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-text-secondary)] md:hidden"
			aria-label="Open menu"
			aria-haspopup="dialog"
			aria-expanded={menuOpen}
			onclick={() => (menuOpen = true)}
		>
			<Menu class="h-5 w-5" aria-hidden="true" />
		</button>
	</div>
</header>

<!-- Mobile menu: same bottom sheet as the file actions, so the app feels like one piece. -->
<div class="md:hidden">
	<BottomSheet open={menuOpen} title="Menu" onClose={() => (menuOpen = false)}>
		<div class="flex items-center gap-2 px-5 pb-1 pt-2">
			<ShieldCheck class="h-4 w-4" style="color: var(--color-accent)" aria-hidden="true" />
			<span class="text-sm font-medium tracking-tight">EndToEnd Encrypt</span>
		</div>

		<nav class="p-2" aria-label="Main">
			{#each links as link (link.href)}
				{@const Icon = link.icon}
				{@const active = page.url.pathname === link.href}
				<a
					href={link.href}
					onclick={() => (menuOpen = false)}
					aria-current={active ? 'page' : undefined}
					class="flex h-12 items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm hover:bg-[var(--color-surface-3)] {active
						? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent)]'
						: 'text-[var(--color-text-primary)]'}"
				>
					<Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
					{link.label}
					{#if active}<span class="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true"></span>{/if}
				</a>
			{/each}
		</nav>

		<div class="mx-4 border-t border-[var(--color-border)]"></div>

		<div class="p-2">
			<button
				type="button"
				onclick={signOut}
				class="flex h-12 w-full cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-3 text-left text-sm text-[var(--color-danger)] hover:bg-[var(--color-surface-3)]"
			>
				<LogOut class="h-4 w-4 shrink-0" aria-hidden="true" /> Sign out
			</button>
		</div>
	</BottomSheet>
</div>
