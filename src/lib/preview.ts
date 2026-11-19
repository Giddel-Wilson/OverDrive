import type { DecryptedMetadata } from '$crypto/download-pipeline';

export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text';

const MiB = 1024 * 1024;

/** Max size we'll decrypt into memory just to preview (full download is always available). */
const LIMITS: Record<PreviewKind, number> = {
	image: 50 * MiB,
	pdf: 100 * MiB,
	video: 300 * MiB,
	audio: 100 * MiB,
	text: 1 * MiB
};

const EXT_MIME: Record<string, string> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
	bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf',
	mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
	mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
	txt: 'text/plain', md: 'text/plain', csv: 'text/plain', json: 'text/plain', xml: 'text/plain', log: 'text/plain',
	yml: 'text/plain', yaml: 'text/plain', toml: 'text/plain', ini: 'text/plain', js: 'text/plain', ts: 'text/plain',
	css: 'text/plain', py: 'text/plain', sh: 'text/plain', sql: 'text/plain', svelte: 'text/plain'
};

// Never rendered as markup: html/svg-as-document are shown only via <img>/<pre>, never injected.
const TEXTLIKE_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript))/;

/** What kind of preview (if any) this file supports, and the MIME to render it with. */
export function previewInfo(meta: Pick<DecryptedMetadata, 'name' | 'mimeType' | 'size'> | null): { kind: PreviewKind; mime: string } | null {
	if (!meta) return null;
	const ext = meta.name.includes('.') ? meta.name.split('.').pop()!.toLowerCase() : '';
	const generic = !meta.mimeType || meta.mimeType === 'application/octet-stream';
	const mime = generic ? (EXT_MIME[ext] ?? '') : meta.mimeType.split(';')[0].trim().toLowerCase();

	let kind: PreviewKind | null = null;
	if (mime.startsWith('image/')) kind = 'image';
	else if (mime === 'application/pdf') kind = 'pdf';
	else if (mime.startsWith('video/')) kind = 'video';
	else if (mime.startsWith('audio/')) kind = 'audio';
	else if (TEXTLIKE_MIME.test(mime) || (generic && EXT_MIME[ext]?.startsWith('text/'))) kind = 'text';
	if (!kind || meta.size > LIMITS[kind]) return null;

	// Text is always rendered as plain text, whatever it claims to be.
	return { kind, mime: kind === 'text' ? 'text/plain' : mime };
}
