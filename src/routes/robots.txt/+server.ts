import { text } from '@sveltejs/kit';
import { siteOrigin } from '$server/seo';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	// Keep account and share pages crawlable so crawlers can read their noindex header.
	const rules = ['User-agent: *', 'Disallow: /api/'];
	if (url.origin === siteOrigin) rules.push('', `Sitemap: ${siteOrigin}/sitemap.xml`);
	return text(rules.join('\n') + '\n');
};
