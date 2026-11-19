/**
 * Shared Tailwind class strings, so buttons / inputs / alerts look the same
 * everywhere without repeating long arbitrary-value utilities. Plain
 * strings (not CSS): Tailwind picks the classes up by scanning this file.
 */
export const ui = {
	input:
		'h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] disabled:opacity-60',
	label: 'text-sm font-medium text-[var(--color-text-secondary)]',
	btnPrimary:
		'inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-bg)] cursor-pointer transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
	btnGhost:
		'inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-text-secondary)] cursor-pointer hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60',
	btnDanger:
		'inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-danger)] px-4 text-sm font-medium text-[var(--color-bg)] cursor-pointer hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
	iconBtn:
		'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-text-secondary)] cursor-pointer transition-colors duration-150 hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50',
	iconBtnDanger:
		'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-danger)] cursor-pointer transition-colors duration-150 hover:border-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-50',
	card: 'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]',
	alertDanger:
		'rounded-[var(--radius-md)] border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2.5 text-sm text-[var(--color-danger)]',
	alertOk:
		'rounded-[var(--radius-md)] border border-[var(--color-accent)] bg-[var(--color-accent-bg)] px-3 py-2.5 text-sm text-[var(--color-accent)]',
	alertInfo:
		'rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2.5 text-sm text-[var(--color-text-secondary)]',
	mono: 'font-mono-data'
} as const;

/** Segmented-choice button state (used for algorithm pickers). */
export const choiceClass = (selected: boolean) =>
	selected
		? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[var(--color-accent)]'
		: 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]';
