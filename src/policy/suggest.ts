// suggest.ts — the nearest known key to a mistyped one, for "did you mean" in policy errors.

function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) {
			next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
		}
		row = next;
	}
	return row[b.length] ?? 0;
}

/** The candidate within two edits of `key`, nearest first; undefined when none is that close. */
export function closest(key: string, candidates: readonly string[]): string | undefined {
	const scored = candidates.map((c) => [c, distance(key, c)] as const).filter(([, d]) => d <= 2);
	return scored.sort((x, y) => x[1] - y[1])[0]?.[0];
}
