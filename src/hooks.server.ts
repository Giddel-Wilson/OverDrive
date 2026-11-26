import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { readSessionCookie } from '$server/auth-server';
import { siteOrigin } from '$server/seo';

// Applied in production only — dev builds aren't what's exposed to the
// internet, and some of these (HSTS especially) make no sense over the
// plain-HTTP local dev server anyway. Note: Content-Security-Policy is
// NOT set here — it's configured via `kit.csp` in svelte.config.js
// instead, so SvelteKit can compute the correct hash for its own inline
// hydration script on every page. A hardcoded CSP header here previously
// blocked that script outright, since its content (and therefore its
// hash) differs per page.
const SECURITY_HEADERS: Record<string, string> = {
	'X-Frame-Options': 'DENY',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
	'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload'
};

export const handle: Handle = async ({ event, resolve }) => {
	const routeId = event.route?.id;
	const publicPage = routeId === '/(public)' || routeId?.startsWith('/(public)/');
	const discoveryFile = routeId === '/robots.txt' || routeId === '/sitemap.xml';
	event.locals.user = publicPage || discoveryFile ? null : await readSessionCookie(event.cookies);
	const response = await resolve(event);

	if ((!publicPage && !discoveryFile) || event.isDataRequest || response.status >= 400 || event.url.origin !== siteOrigin) {
		response.headers.set('X-Robots-Tag', 'noindex');
	}

	if (!dev) {
		for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
			response.headers.set(key, value);
		}
	}

	return response;
};
