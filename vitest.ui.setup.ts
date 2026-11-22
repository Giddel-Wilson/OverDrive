// jsdom doesn't implement matchMedia; the sheets / bar use it to honour "reduce motion".
if (!window.matchMedia) {
	window.matchMedia = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false
		}) as unknown as MediaQueryList;
}

// Nor Web Animations, which Svelte's in/out transitions drive. A stub that
// "finishes" immediately keeps transitions from stalling element removal.
if (!Element.prototype.animate) {
	Element.prototype.animate = function () {
		const animation = {
			onfinish: null as null | (() => void),
			oncancel: null,
			currentTime: 0,
			finished: Promise.resolve(),
			cancel() {},
			finish() {},
			play() {},
			pause() {},
			reverse() {}
		};
		setTimeout(() => animation.onfinish?.(), 0);
		return animation as unknown as Animation;
	};
}
