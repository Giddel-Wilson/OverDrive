/**
 * Minimal streaming ZIP writer ("store" method, no compression) with ZIP64.
 *
 * Why not fflate's Zip: its streaming writer has no ZIP64 support, so any
 * archive or entry over 4 GiB would be silently corrupt — and a vault
 * export is exactly where that size is reached. Here every entry is
 * written with a data descriptor (sizes and CRC come after the bytes,
 * which is what makes streaming possible); entries ≥ 4 GiB, offsets
 * ≥ 4 GiB and entry counts ≥ 65 535 use the ZIP64 structures.
 *
 * Decrypted file data is typically already compressed (images, video,
 * PDFs, archives), so storing it costs almost nothing in size.
 */

const TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/** Running CRC-32; feed it the previous return value (start from 0). */
export function crc32Update(prev: number, data: Uint8Array): number {
	let c = (prev ^ 0xffffffff) >>> 0;
	for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const ZIP64_THRESHOLD = U32_MAX; // sizes / offsets that need 8 bytes

class Bytes {
	private parts: number[] = [];
	u8(v: number) { this.parts.push(v & 0xff); return this; }
	u16(v: number) { this.u8(v); this.u8(v >>> 8); return this; }
	u32(v: number) { this.u16(v & 0xffff); this.u16(Math.floor(v / 0x10000) & 0xffff); return this; }
	u64(v: number) { this.u32(v % 0x100000000); this.u32(Math.floor(v / 0x100000000)); return this; }
	raw(b: Uint8Array) { for (const x of b) this.parts.push(x); return this; }
	done() { return new Uint8Array(this.parts); }
}

function dosDateTime(d: Date) {
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
	const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

export interface ZipOutput {
	write(chunk: Uint8Array): void | Promise<void>;
}

interface CentralRecord {
	name: Uint8Array;
	crc: number;
	size: number;
	offset: number;
	isDir: boolean;
	zip64Entry: boolean;
	time: number;
	date: number;
}

export class ZipWriter {
	private offset = 0;
	private central: CentralRecord[] = [];
	private encoder = new TextEncoder();

	/** `forceZip64` exists so tests can exercise the ZIP64 paths without 4 GiB of data. */
	constructor(
		private out: ZipOutput,
		private opts: { forceZip64?: boolean } = {}
	) {}

	private async emit(bytes: Uint8Array) {
		await this.out.write(bytes);
		this.offset += bytes.length;
	}

	/** Adds a folder entry (name should use "/" separators; a trailing slash is added). */
	async addDirectory(path: string, mtime = new Date()) {
		const name = this.encoder.encode(path.endsWith('/') ? path : `${path}/`);
		const { time, date } = dosDateTime(mtime);
		const offset = this.offset;
		const h = new Bytes()
			.u32(0x04034b50).u16(20).u16(0x0800).u16(0).u16(time).u16(date)
			.u32(0).u32(0).u32(0).u16(name.length).u16(0).raw(name);
		await this.emit(h.done());
		this.central.push({ name, crc: 0, size: 0, offset, isDir: true, zip64Entry: false, time, date });
	}

	/**
	 * Adds a file whose size is known up front (it is — it's in the file's
	 * decrypted metadata). `produce` calls `push` for each piece of data, in
	 * order; await `push` to get backpressure.
	 */
	async addFile(
		path: string,
		size: number,
		produce: (push: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
		mtime = new Date()
	) {
		const name = this.encoder.encode(path);
		const { time, date } = dosDateTime(mtime);
		const zip64Entry = this.opts.forceZip64 === true || size >= ZIP64_THRESHOLD;
		const offset = this.offset;

		// Local header. Bit 3 → CRC/sizes follow the data in a descriptor.
		const h = new Bytes().u32(0x04034b50).u16(zip64Entry ? 45 : 20).u16(0x0808).u16(0).u16(time).u16(date).u32(0);
		if (zip64Entry) {
			h.u32(U32_MAX).u32(U32_MAX).u16(name.length).u16(20).raw(name).u16(0x0001).u16(16).u64(0).u64(0);
		} else {
			h.u32(0).u32(0).u16(name.length).u16(0).raw(name);
		}
		await this.emit(h.done());

		let crc = 0;
		let written = 0;
		await produce(async (chunk) => {
			crc = crc32Update(crc, chunk);
			written += chunk.length;
			await this.emit(chunk);
		});

		// Data descriptor: 8-byte sizes when the entry is ZIP64, 4-byte otherwise.
		const d = new Bytes().u32(0x08074b50).u32(crc);
		if (zip64Entry) d.u64(written).u64(written);
		else d.u32(written).u32(written);
		await this.emit(d.done());

		this.central.push({ name, crc, size: written, offset, isDir: false, zip64Entry, time, date });
	}

	/** Writes the central directory and end records. Call once, after the last entry. */
	async finish() {
		const cdStart = this.offset;
		for (const r of this.central) {
			const needOffset64 = this.opts.forceZip64 === true || r.offset >= ZIP64_THRESHOLD;
			const extra = new Bytes();
			// Order is fixed by the spec: uncompressed size, compressed size, offset.
			if (r.zip64Entry) extra.u64(r.size).u64(r.size);
			if (needOffset64) extra.u64(r.offset);
			const extraBytes = extra.done();
			const hasExtra = extraBytes.length > 0;

			const c = new Bytes()
				.u32(0x02014b50)
				.u16(hasExtra ? 45 : 20) // version made by
				.u16(hasExtra ? 45 : 20) // version needed
				.u16(r.isDir ? 0x0800 : 0x0808)
				.u16(0)
				.u16(r.time).u16(r.date)
				.u32(r.crc)
				.u32(r.zip64Entry ? U32_MAX : r.size)
				.u32(r.zip64Entry ? U32_MAX : r.size)
				.u16(r.name.length)
				.u16(hasExtra ? 4 + extraBytes.length : 0)
				.u16(0).u16(0).u16(0)
				.u32(r.isDir ? 0x10 : 0) // external attrs: directory flag
				.u32(needOffset64 ? U32_MAX : r.offset)
				.raw(r.name);
			if (hasExtra) c.u16(0x0001).u16(extraBytes.length).raw(extraBytes);
			await this.emit(c.done());
		}
		const cdSize = this.offset - cdStart;
		const count = this.central.length;

		const needZip64End =
			this.opts.forceZip64 === true || count >= U16_MAX || cdStart >= ZIP64_THRESHOLD || cdSize >= ZIP64_THRESHOLD;

		if (needZip64End) {
			const z64Start = this.offset;
			await this.emit(
				new Bytes()
					.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
					.u64(count).u64(count).u64(cdSize).u64(cdStart)
					.done()
			);
			await this.emit(new Bytes().u32(0x07064b50).u32(0).u64(z64Start).u32(1).done());
		}

		await this.emit(
			new Bytes()
				.u32(0x06054b50).u16(0).u16(0)
				.u16(needZip64End ? U16_MAX : count)
				.u16(needZip64End ? U16_MAX : count)
				.u32(needZip64End ? U32_MAX : cdSize)
				.u32(needZip64End ? U32_MAX : cdStart)
				.u16(0)
				.done()
		);
	}
}
