import { assertBranchName } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { branchName, hostSlug, repoSlug, rineAgentName } from "../src/identity/names.js";

const AGENT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;

describe("names", () => {
	it("slugs unicode and uppercase repo names", () => {
		expect(repoSlug("/home/x/Café Münster_Repo")).toBe("cafe-munster-repo");
		expect(repoSlug("/home/x/日本語")).toBe("repo");
	});

	it("clips an over-long repo name and keeps it valid", () => {
		const name = rineAgentName(repoSlug(`/x/${"a-".repeat(200)}`), "Reviewer");
		expect(name.endsWith("-reviewer")).toBe(true);
		expect(AGENT_NAME_RE.test(name)).toBe(true);
	});

	it("falls back to the repo slug for an empty role", () => {
		expect(rineAgentName("proj", "!!!")).toBe("proj");
	});

	it("derives a branch name the core accepts for fuzzed hostnames", () => {
		const alphabet = "abcXYZ019.-_ éü日";
		for (let i = 0; i < 50; i++) {
			const host = Array.from({ length: 1 + ((i * 7) % 70) }, (_, j) => alphabet[(i * 31 + j * 17) % alphabet.length]).join("");
			expect(() => assertBranchName(branchName(host))).not.toThrow();
		}
		expect(branchName("")).toBe("herdr-host");
		expect(branchName("My.Laptop")).toBe("herdr-my-laptop");
		expect(hostSlug("-x".repeat(30)).length).toBeLessThanOrEqual(20);
	});
});
