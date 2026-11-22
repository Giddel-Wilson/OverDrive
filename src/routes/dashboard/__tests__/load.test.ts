import { describe, it, expect } from 'vitest';
import { load } from '../+page';

describe('vault listing failures', () => {
	it('reports a failed file API request so the UI cannot display it as an empty vault', async () => {
		const result = await load({ fetch: async (path: string) => new Response(JSON.stringify(path === '/api/files' ? { message: 'File listing unavailable' } : path === '/api/folders' ? { folders: [] } : { files: [] }), { status: path === '/api/files' ? 503 : 200 }) } as never);
		expect(result).toMatchObject({ listingError: 'File listing unavailable' });
	});
});
