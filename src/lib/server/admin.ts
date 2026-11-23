import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUser, type SessionUser } from './auth';

/** ADMIN_EMAILS=you@example.com,other@example.com — accounts allowed to manage storage and backups. */
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
