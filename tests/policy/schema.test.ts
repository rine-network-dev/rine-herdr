import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyError, loadPolicy, parsePolicy } from "../../src/policy/schema.js";

const FULL = `
profile = "team"
[local]
graph = [["*", "*"]]
[external]
orgs = ["7c1e0a52-3b0f-4d6e-9a41-0f2d5c7b8e13"]
first_contact = "approve"
[[external.groups]]
handle = "#platform-dev@teamb.rine.network"
agents = ["lead", "reviewer"]
[features]
tools = ["rine_inspect"]
[[agents]]
name = "reviewer"
role = "reviewer"
`;

describe("parsePolicy", () => {
	it("parses the full example", () => {
		const p = parsePolicy(FULL);
		expect(p).toMatchObject({
			profile: "team",
			graph: [["*", "*"]],
			firstContact: "approve",
			featureTools: ["rine_inspect"],
			externalIgnored: false,
		});
		expect(p.externalGroups).toEqual([{ handle: "#platform-dev@teamb.rine.network", agents: ["lead", "reviewer"] }]);
	});

	it("defaults to solo with every agent talking to every other", () => {
		expect(parsePolicy("")).toMatchObject({ profile: "solo", graph: [["*", "*"]], externalOrgs: [], externalIgnored: false });
	});

	it("flags an external table under solo", () => {
		expect(parsePolicy('[external]\norgs = []').externalIgnored).toBe(true);
	});

	it.each([
		["an unknown key", 'colour = "red"', /line 1: unknown key "colour"/],
		["a mistyped key, with the nearest real one", 'profil = "team"', /line 1: unknown key "profil" \(did you mean "profile"\?\)/],
		["a bad profile", 'profile = "wild"', /profile/],
		["a non-uuid org", 'profile = "team"\n[external]\norgs = ["acme"]', /external\.orgs\.0/],
		["a bad graph name", '[local]\ngraph = [["Lead", "a"]]', /local\.graph\.0\.0/],
		["a feature outside the optional list", '[features]\ntools = ["rine_send"]', /features\.tools\.0/],
		["an unknown nested key", "[local]\nedges = []", /line 2: unknown key "edges" in \[local\]/],
		["broken toml", "profile = ", /rine-herdr\.toml/],
	])("rejects %s naming the key", (_label, text, pattern) => {
		expect(() => parsePolicy(text)).toThrow(PolicyError);
		expect(() => parsePolicy(text)).toThrow(pattern);
	});
});

describe("loadPolicy", () => {
	it("reads the file at the repo root and falls back to defaults when absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-policy-"));
		expect(loadPolicy(dir).profile).toBe("solo");
		writeFileSync(join(dir, "rine-herdr.toml"), 'profile = "open"');
		expect(loadPolicy(dir).profile).toBe("open");
	});
});
