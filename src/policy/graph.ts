// graph.ts — expands the policy's `local.graph` rows into the cliques that become groups.
const WILDCARD = "*";

/** Drop every clique that is a subset of another (and duplicates), then sort for a stable result. */
function maximal(cliques: readonly (readonly string[])[]): string[][] {
	const unique = new Map(cliques.map((c) => [c.join("\0"), [...c].sort()]));
	const all = [...unique.values()];
	const kept = all.filter((c) => !all.some((o) => o !== c && o.length > c.length && c.every((n) => o.includes(n))));
	return kept.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

function expandRow(row: readonly string[], bound: readonly string[]): string[][] {
	const names = row.filter((n) => n === WILDCARD || bound.includes(n));
	if (row.length === 2 && names.length === 2 && names.includes(WILDCARD) && !names.every((n) => n === WILDCARD)) {
		const anchor = names.find((n) => n !== WILDCARD) as string;
		return bound.filter((n) => n !== anchor).map((n) => [anchor, n]);
	}
	if (row.length === 2 && names.length < 2) return [];
	const members = new Set(names.flatMap((n) => (n === WILDCARD ? bound : [n])));
	return members.size >= 2 ? [[...members]] : [];
}

export function cliques(graph: readonly (readonly string[])[], boundNames: readonly string[]): string[][] {
	const bound = [...new Set(boundNames)].sort();
	return maximal(graph.flatMap((row) => expandRow(row, bound)));
}
