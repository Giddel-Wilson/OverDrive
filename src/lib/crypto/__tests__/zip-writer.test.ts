import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ZipWriter, crc32Update } from '../zip-writer';
import { randomBytes } from './fake-server';

// Windows can expose an uninstalled Store alias as python3. Probe the
// optional independent reader instead of assuming that alias is usable.
const pythonReader = [process.env.PYTHON_BIN, 'python3', 'python'].filter((command): command is string => Boolean(command))
	.find((command) => spawnSync(command, ['--version'], { windowsHide: true }).status === 0);

async function build(forceZip64: boolean) {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter({ write: (c) => void parts.push(c) }, { forceZip64 });
	const big = randomBytes(300_000);
	await zip.addDirectory('empty-folder');
	await zip.addFile('hello.txt', 5, async (push) => push(new TextEncoder().encode('hello')));
	await zip.addFile('docs/ünïcode — name.bin', big.length, async (push) => {
		for (let i = 0; i < big.length; i += 100_000) await push(big.slice(i, i + 100_000)); // multi-piece
	});
	await zip.addFile('empty.txt', 0, async () => {});
	await zip.finish();
	const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) (total.set(p, o), (o += p.length));
	return { bytes: total, big };
}

describe('crc32', () => {
	it('matches the standard check value and is incremental', () => {
		const data = new TextEncoder().encode('123456789');
		expect(crc32Update(0, data)).toBe(0xcbf43926);
		expect(crc32Update(crc32Update(0, data.slice(0, 4)), data.slice(4))).toBe(0xcbf43926);
	});
});

describe.each([false, true])('ZipWriter (forceZip64=%s)', (forceZip64) => {
	it('produces an archive fflate can read, byte-for-byte', async () => {
		const { bytes, big } = await build(forceZip64);
		const files = unzipSync(bytes);
		expect(strFromU8(files['hello.txt'])).toBe('hello');
		expect(files['docs/ünïcode — name.bin']).toEqual(big);
		expect(files['empty.txt'].length).toBe(0);
		expect(Object.keys(files)).toContain('empty-folder/');
	});

	it.skipIf(!pythonReader)('passes an independent Python zipfile CRC check when Python is installed', async () => {
		const { bytes } = await build(forceZip64);
		const dir = mkdtempSync(join(tmpdir(), 'zipw-'));
		const path = join(dir, 'out.zip');
		writeFileSync(path, bytes);
		const out = execFileSync(
			pythonReader!,
			['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(sorted(z.namelist()))\nprint(len(z.read('docs/ünïcode — name.bin')))`, path],
			{ encoding: 'utf8' }
		);
		expect(out).toContain('hello.txt');
		expect(out).toContain('300000');
		expect(readFileSync(path).length).toBe(bytes.length);
	});
});
