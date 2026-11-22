import { describe, it, expect } from 'vitest';
import { describeDevice, timeAgo } from '../format';

describe('describeDevice', () => {
	it.each([
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Chrome on Windows'],
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 'Edge on Windows'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS'],
		['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
		['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
		['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox on Linux'],
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0', 'Opera on Windows']
	])('%s', (ua, expected) => expect(describeDevice(ua)).toBe(expected));

	it('copes with missing or odd agents', () => {
		expect(describeDevice(null)).toBe('Unknown device');
		expect(describeDevice('curl/8.4.0')).toBe('Unknown device');
	});
});

describe('timeAgo', () => {
	const now = Date.parse('2026-11-20T12:00:00Z');
	const ago = (s: number) => timeAgo(new Date(now - s * 1000), now);
	it('formats common spans', () => {
		expect(ago(5)).toBe('just now');
		expect(ago(60)).toBe('1 minute ago');
		expect(ago(5 * 60)).toBe('5 minutes ago');
		expect(ago(3600)).toBe('1 hour ago');
		expect(ago(5 * 3600)).toBe('5 hours ago');
		expect(ago(86400)).toBe('1 day ago');
		expect(ago(3 * 86400)).toBe('3 days ago');
		expect(ago(40 * 86400)).toBe('1 month ago');
		expect(ago(400 * 86400)).toBe('1 year ago');
	});
});
