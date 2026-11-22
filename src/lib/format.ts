/** "Chrome on Windows" from a User-Agent string — good enough for a device list, not a fingerprint. */
export function describeDevice(userAgent: string | null | undefined): string {
	if (!userAgent) return 'Unknown device';
	const ua = userAgent;

	const os = /Windows/i.test(ua)
		? 'Windows'
		: /Android/i.test(ua)
			? 'Android'
			: /iPhone|iPad|iPod/i.test(ua)
				? 'iOS'
				: /Mac OS X|Macintosh/i.test(ua)
					? 'macOS'
					: /CrOS/i.test(ua)
						? 'ChromeOS'
						: /Linux/i.test(ua)
							? 'Linux'
							: null;

	// Order matters: Edge and Opera also say "Chrome"; Chrome also says "Safari".
	const browser = /Edg(e|A|iOS)?\//.test(ua)
		? 'Edge'
		: /OPR\/|Opera/.test(ua)
			? 'Opera'
			: /Firefox\/|FxiOS\//.test(ua)
				? 'Firefox'
				: /Chrome\/|CriOS\//.test(ua)
					? 'Chrome'
					: /Safari\//.test(ua)
						? 'Safari'
						: null;

	if (browser && os) return `${browser} on ${os}`;
	return browser ?? os ?? 'Unknown device';
}

/** "just now", "5 minutes ago", "3 days ago". */
export function timeAgo(date: string | Date, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
	if (seconds < 60) return 'just now';
	const units: [number, string][] = [
		[60, 'minute'],
		[60 * 60, 'hour'],
		[60 * 60 * 24, 'day'],
		[60 * 60 * 24 * 30, 'month']
	];
	let value = Math.floor(seconds / 60);
	let unit = 'minute';
	for (const [size, name] of units) {
		if (seconds >= size) {
			value = Math.floor(seconds / size);
			unit = name;
		}
	}
	if (seconds >= 60 * 60 * 24 * 365) {
		value = Math.floor(seconds / (60 * 60 * 24 * 365));
		unit = 'year';
	}
	return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}
