<script lang="ts">
	import { Lock, KeyRound, Link2, ArrowRight } from 'lucide-svelte';
</script>

<main>
	<section class="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center">
		<h1 class="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
			Encrypted cloud storage for your private files
		</h1>
		<p class="mx-auto mt-5 max-w-xl text-base text-[var(--color-text-secondary)]">
			OverDrive encrypts your files and their names in your browser before upload. Keep documents
			and photos in your vault, or send someone a password-protected link to a single file.
		</p>
		<div class="mt-8 flex items-center justify-center gap-3">
			<a href="/register" class="flex h-11 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90">
				Create your vault <ArrowRight class="h-4 w-4" aria-hidden="true" />
			</a>
			<a href="/login" class="flex h-11 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-5 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">Sign in</a>
		</div>
	</section>

	<section class="border-t border-[var(--color-border)] bg-[var(--color-surface)] py-16">
		<div class="mx-auto max-w-5xl px-6">
			<h2 class="text-center text-xl font-semibold tracking-tight">How the OverDrive vault works</h2>
			<div class="mt-8 grid gap-6 sm:grid-cols-3">
				<section class="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-6">
					<Lock class="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
					<h3 class="mt-4 font-medium">Encrypt before upload</h3>
					<p class="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
						Your browser encrypts each file with a fresh key. It also encrypts filenames and photo
						thumbnails, so you can browse them when you unlock your vault.
					</p>
					<a class="mt-4 inline-block text-sm text-[var(--color-accent)] underline" href="/encrypted-cloud-storage">How file encryption works</a>
				</section>
				<section class="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-6">
					<KeyRound class="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
					<h3 class="mt-4 font-medium">Recover your vault</h3>
					<p class="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
						Save your recovery kit somewhere outside your vault. If you forget your password, the
						recovery key lets you choose a new password and open your files again.
					</p>
				</section>
				<section class="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-6">
					<Link2 class="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
					<h3 class="mt-4 font-medium">Share one file</h3>
					<p class="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
						Give someone a link and a separate password. They can decrypt that version of the file
						in their browser without opening an OverDrive account.
					</p>
					<a class="mt-4 inline-block text-sm text-[var(--color-accent)] underline" href="/password-protected-file-sharing">How to share a file securely</a>
				</section>
			</div>
		</div>
	</section>
</main>
