import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Welcome from './Welcome.svelte';

describe('Welcome.svelte', () => {
	it('renders greetings for host and guest', async () => {
		const { body } = render(Welcome, { props: { host: 'SvelteKit', guest: 'Vitest' } });
		expect(body).toContain('Hello, SvelteKit!');
		expect(body).toContain('Hello, Vitest!');
	});
});
