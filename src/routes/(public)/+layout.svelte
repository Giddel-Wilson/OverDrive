<script lang="ts">
	import { ShieldCheck } from 'lucide-svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const logo = $derived(data.siteOrigin + '/overdrive.png');
	const structuredData = $derived({
		'@context': 'https://schema.org',
		'@graph': [
			{ '@type': 'WebSite', '@id': data.siteOrigin + '/#website', name: 'OverDrive', url: data.siteOrigin + '/' },
			{
				'@type': 'WebApplication',
				name: 'OverDrive',
				url: data.siteOrigin + '/',
				image: logo,
				applicationCategory: 'SecurityApplication',
				operatingSystem: 'Web',
				description: data.description
			}
		]
	});
</script>

<svelte:head>
	<title>{data.title}</title>
	<meta name="description" content={data.description} />
	<link rel="canonical" href={data.canonical} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="OverDrive" />
	<meta property="og:title" content={data.title} />
	<meta property="og:description" content={data.description} />
	<meta property="og:url" content={data.canonical} />
	<meta property="og:image" content={logo} />
	<meta property="og:image:width" content="512" />
	<meta property="og:image:height" content="512" />
	<meta property="og:image:alt" content="OverDrive shield and checkmark" />
	<meta name="twitter:card" content="summary" />
	{#if data.path === '/'}
		{@html '<script type="application/ld+json">' + JSON.stringify(structuredData).replaceAll('<', '\\u003c') + '</' + 'script>'}
	{/if}
</svelte:head>

<header class="border-b border-[var(--color-border)]">
	<div class="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
		<a href="/" class="flex items-center gap-2 font-semibold tracking-tight">
			<ShieldCheck class="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
			OverDrive
		</a>
		<nav class="flex items-center gap-4 text-sm" aria-label="Account">
			<a href="/login" class="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">Sign in</a>
			<a href="/register" class="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3.5 py-2 font-medium text-[var(--color-bg)] hover:opacity-90">Create vault</a>
		</nav>
	</div>
</header>

{@render children()}

<footer class="border-t border-[var(--color-border)] py-8">
	<nav class="mx-auto flex max-w-5xl flex-wrap justify-center gap-x-6 gap-y-3 px-6 text-sm text-[var(--color-text-secondary)]" aria-label="OverDrive guides">
		<a class="hover:underline" href="/">OverDrive</a>
		<a class="hover:underline" href="/encrypted-cloud-storage">Encrypted cloud storage</a>
		<a class="hover:underline" href="/password-protected-file-sharing">Password-protected file sharing</a>
	</nav>
</footer>
