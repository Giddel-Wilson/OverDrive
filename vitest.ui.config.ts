// UI smoke tests: mounts real Svelte components in jsdom. Kept separate from
// the default config (`npm test`) because components must resolve Svelte's
// *browser* build, which the server-side tests don't want.
//   npm run test:ui
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	resolve: { conditions: ['browser'] },
	test: {
		environment: 'jsdom',
		include: ['src/**/*.ui.ts'],
		setupFiles: ['./vitest.ui.setup.ts'],
		testTimeout: 60_000
	}
});
