import fs from 'node:fs';
import path from 'node:path';

/** @param {import('@sveltejs/kit').Adapter} adapter */
export function windowsVercelAdapter(adapter) {
	if (process.platform !== 'win32') return adapter;
	return {
		...adapter,
		/** @param {import('@sveltejs/kit').Builder} builder */
		async adapt(builder) {
			const original = fs.symlinkSync;
			const root = path.resolve('.vercel/output/functions');
			/** @param {string} candidate */
			const inside = (candidate) => {
				const relative = path.relative(root, candidate);
				return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
			};
			// Windows directory junctions work without the administrator/developer
			// privilege required by symlinks. Limit fallback to generated functions.
			fs.symlinkSync = (target, destination, type) => {
				try { return original(target, destination, type); }
				catch (error) {
					if (typeof target !== 'string' || typeof destination !== 'string' || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EPERM') throw error;
					const link = path.resolve(destination);
					const absoluteTarget = path.resolve(path.dirname(link), target);
					if (!inside(link) || !inside(absoluteTarget)) throw error;
					const stat = fs.statSync(absoluteTarget);
					if (stat.isDirectory()) return original(absoluteTarget, link, 'junction');
					if (stat.isFile()) return fs.copyFileSync(absoluteTarget, link);
					throw error;
				}
			};
			try { await adapter.adapt(builder); }
			finally { fs.symlinkSync = original; }
		}
	};
}
