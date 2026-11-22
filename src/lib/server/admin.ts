import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUser, type SessionUser } from './auth';

/** ADMIN_EMAILS=you@example.com,other@example.com — the accounts allowed to manage invites and users. */
export function adminEmails(): Set<string> {
	return new Set(
		(env.ADMIN_EMAILS ?? '')
			.split(',')
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean)
	);
}

export const isAdminEmail = (email: string) => adminEmails().has(email.toLowerCase());

export function requireAdmin(locals: App.Locals): SessionUser {
	const user = requireUser(locals);
	if (!isAdminEmail(user.email)) error(403, 'Admins only');
	return user;
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

/** REGISTRATION_MODE = open | invite | closed. Defaults to invite-only. */
export function configuredRegistrationMode(): RegistrationMode {
	const m = (env.REGISTRATION_MODE ?? 'invite').toLowerCase();
	return m === 'open' || m === 'closed' ? m : 'invite';
}
