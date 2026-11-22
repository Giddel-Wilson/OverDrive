const locks = new WeakMap<Document, { count: number; previous: string }>();

/** Keep scrolling locked until every open dialog/sheet releases its lock. */
export function lockBodyScroll(doc: Document = document) {
	const state = locks.get(doc) ?? { count: 0, previous: doc.body.style.overflow };
	state.count++;
	locks.set(doc, state);
	doc.body.style.overflow = 'hidden';
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--state.count === 0) {
			doc.body.style.overflow = state.previous;
			locks.delete(doc);
		}
	};
}
