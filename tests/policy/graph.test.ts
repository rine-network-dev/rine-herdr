import { describe, expect, it } from "vitest";
import { cliques } from "../../src/policy/graph.js";

describe("cliques", () => {
	it("turns the all-pairs wildcard into one clique of the bound names", () => {
		expect(cliques([["*", "*"]], ["c", "a", "b"])).toEqual([["a", "b", "c"]]);
	});

	it("expands a star into pairs, not a clique", () => {
		expect(cliques([["lead", "*"]], ["lead", "a", "b"])).toEqual([["a", "lead"], ["b", "lead"]]);
		expect(cliques([["lead", "*"], ["a", "b"]], ["lead", "a", "b"])).toEqual([["a", "b"], ["a", "lead"], ["b", "lead"]]);
	});

	it("keeps chained pairs as separate cliques", () => {
		expect(cliques([["a", "b"], ["b", "c"]], ["a", "b", "c"])).toEqual([["a", "b"], ["b", "c"]]);
	});

	it("ignores unbound names", () => {
		expect(cliques([["a", "ghost"], ["lead", "*"]], ["a"])).toEqual([]);
		expect(cliques([["a", "b", "ghost"]], ["a", "b"])).toEqual([["a", "b"]]);
	});

	it("treats a longer row without a wildcard as one clique and merges subsets", () => {
		expect(cliques([["a", "b", "c"], ["a", "b"]], ["a", "b", "c"])).toEqual([["a", "b", "c"]]);
	});

	it("is stable across permutations of the input", () => {
		const graph = [["lead", "*"], ["a", "b"]];
		const first = cliques(graph, ["lead", "a", "b"]);
		expect(cliques([...graph].reverse(), ["b", "lead", "a"])).toEqual(first);
	});
});
