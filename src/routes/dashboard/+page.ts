import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [filesRes, foldersRes, pendingRes] = await Promise.all([
		fetch('/api/files'),
		fetch('/api/folders'),
		fetch('/api/files?view=pending')
	]);
	// The session was revoked (signed out from another device) or expired.
	if (filesRes.status === 401) redirect(303, '/login');
	const listingError = filesRes.ok ? null : ((await filesRes.json().catch(() => ({}))).message ?? 'Could not load your files. Please retry.');

	return {
		listingError,
		files: filesRes.ok ? (await filesRes.json()).files : [],
		folders: foldersRes.ok ? (await foldersRes.json()).folders : [],
		pending: pendingRes.ok ? (await pendingRes.json()).files : []
	};
};
