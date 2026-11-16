import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSkills, skillSummary } from "../src/skills/install.js";
import { HERDR_DEFAULT_TOOLS } from "../src/tool-profiles.js";

const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));
const BASE_SKILL = "rine-herdr";
const BASE_MAX_LINES = 150;
const USE_CASE_LINES = { min: 60, max: 120 };
const DESCRIPTION_MAX = 1024;

const skills = readdirSync(SKILLS_DIR).map((name) => ({
	name,
	text: readFileSync(`${SKILLS_DIR}${name}/SKILL.md`, "utf8"),
}));

function frontmatter(text: string): Record<string, string> {
	const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
	return Object.fromEntries([...block.matchAll(/^([a-z-]+): (.*)$/gm)].map((m) => [m[1], m[2]]));
}

describe("bundled skills", () => {
	it("lists the base skill first, then the rest alphabetically", () => {
		expect(listSkills(SKILLS_DIR)).toEqual([BASE_SKILL, "capacity-share", "design-loop", "game-table", "plan-together", "team-sync"]);
	});

	it("summarises each skill as the first sentence of its description", () => {
		for (const name of listSkills(SKILLS_DIR)) {
			const summary = skillSummary(SKILLS_DIR, name);
			expect(summary.length).toBeGreaterThan(10);
			expect(summary).not.toMatch(/\.$/);
		}
	});

	it("ships the base skill and the five use-case skills", () => {
		expect(skills.map((s) => s.name).sort()).toEqual(
			["capacity-share", "design-loop", "game-table", "plan-together", BASE_SKILL, "team-sync"].sort(),
		);
	});

	describe.each(skills)("$name", ({ name, text }) => {
		const lines = text.trimEnd().split("\n").length;
		const meta = frontmatter(text);

		it("names only tools a herdr pane has by default", () => {
			const mentioned = new Set(text.match(/\brine_[a-z0-9_]+\b/g) ?? []);
			const allowed = new Set<string>(HERDR_DEFAULT_TOOLS);
			expect([...mentioned].filter((tool) => !allowed.has(tool))).toEqual([]);
		});

		it("keeps within its line budget", () => {
			if (name === BASE_SKILL) expect(lines).toBeLessThanOrEqual(BASE_MAX_LINES);
			else {
				expect(lines).toBeGreaterThanOrEqual(USE_CASE_LINES.min);
				expect(lines).toBeLessThanOrEqual(USE_CASE_LINES.max);
			}
		});

		it("has frontmatter whose name is its directory and whose description fits", () => {
			expect(meta.name).toBe(name);
			const description = meta.description ?? "";
			expect(description.length).toBeGreaterThan(0);
			expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
		});

		it("has a Safety heading", () => {
			expect(text).toMatch(/^#{1,3} Safety$/m);
		});
	});
});
