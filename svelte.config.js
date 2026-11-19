import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// svelte.config.js runs in plain Node during `vite dev`/`vite build`, not
// inside the app itself, so this checks NODE_ENV directly rather than
// importing `dev` from $app/environment. Keeping CSP production-only
// preserves the original intent: it shouldn't risk interfering with
// Vite's dev-mode HMR for no real security benefit, since dev builds
// aren't what's exposed to the internet.
const isProd = process.env.NODE_ENV === 'production';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			// Keep the function runtime aligned with package.json engines.node.
			runtime: 'nodejs24.x',
			// Encryption happens client-side and ciphertext chunks go straight
			// between the browser and Backblaze B2 through presigned URLs, so
			// file size isn't bound by Vercel's 4.5MB body limit. Functions
			// only coordinate (init / presign / finalize), plus the 2 MiB
			// chunk download route and the relay fallback upload route.
			memory: 1024,
			maxDuration: 60
		}),
		alias: {
			$crypto: 'src/lib/crypto',
			$server: 'src/lib/server'
		},
		// CSP is defined here (not as a manually-built header string in
		// hooks.server.ts) specifically so SvelteKit can compute the correct
		// hash/nonce for its own inline hydration script on every page. That
		// script's content differs per page (it embeds that page's load
		// data), so a single hardcoded hash could never cover every route —
		// this is the one part of the CSP that has to be framework-managed.
		csp: isProd
			? {
					mode: 'auto',
					directives: {
						'default-src': ['self'],
						'script-src': ['self'],
						// 'unsafe-inline' kept for style-src: components use
						// inline style="" attributes for CSS-variable-driven
						// theming (e.g. dynamic strength-indicator colors)
						// rather than a compiled stylesheet. Tightening this
						// to hashes is a reasonable next step if that pattern
						// is replaced with class-based styling.
						'style-src': ['self', 'unsafe-inline'],
						// blob: = decrypted previews (images, video, audio, PDF)
						// rendered from in-memory object URLs, never from a server.
						'img-src': ['self', 'data:', 'blob:'],
						'media-src': ['self', 'blob:'],
						'frame-src': ['self', 'blob:'],
						// Backblaze B2: ciphertext chunks are PUT directly to the
						// bucket via presigned URLs (needs matching bucket CORS —
						// see scripts/set-b2-cors.mjs). Only ciphertext ever goes
						// there. Narrow this to your exact bucket host if you like,
						// e.g. https://YOUR-BUCKET.s3.us-west-004.backblazeb2.com
						'connect-src': ['self', 'https://*.backblazeb2.com'],
						'object-src': ['none'],
						'base-uri': ['self'],
						'frame-ancestors': ['none'],
						'form-action': ['self']
					}
				}
			: undefined
	}
};

export default config;
