import { error } from '@sveltejs/kit';
import { publicPages, siteOrigin } from '$server/seo';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ url, setHeaders }) => {
	const page = publicPages.find(({ path }) => path === url.pathname);
	if (!page) error(404, 'Page not found');

	// Public pages render the same HTML for signed-in and anonymous visitors.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=3600' });
	return {
		...page,
		siteOrigin,
		canonical: siteOrigin + page.path
	};
};
