import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [filesRes, foldersRes, pendingRes] = await Promise.all([
		fetch('/api/files'),
		fetch('/api/folders'),
		fetch('/api/files?view=pending')
	]);
	return {
		files: filesRes.ok ? (await filesRes.json()).files : [],
		folders: foldersRes.ok ? (await foldersRes.json()).folders : [],
		pending: pendingRes.ok ? (await pendingRes.json()).files : []
	};
};
