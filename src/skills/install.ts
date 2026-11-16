// install.ts — copies a bundled skill into a harness's skill directory. The human asks for it; nothing
// installs a skill on its own.
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Harness } from "../mcp/register.js";

/** The skill every agent in a herdr pane needs; the use-case skills build on it. */
export const BASE_SKILL = "rine-herdr";

/** The bundled skills, the base skill first and the rest alphabetical. */
export function listSkills(skillsRoot: string): string[] {
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort((a, b) => Number(b === BASE_SKILL) - Number(a === BASE_SKILL) || a.localeCompare(b));
}

/** The first sentence of a skill's frontmatter `description`; empty when it has none. */
export function skillSummary(skillsRoot: string, name: string): string {
	const description = /^description: (.*)$/m.exec(readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8"))?.[1] ?? "";
	return description.split(/\.\s/)[0]?.replace(/\.$/, "") ?? "";
}

export interface InstallTarget {
	harness: Harness;
	/** Claude Code only: install into this project instead of the user's skills. */
	project?: string;
}

export function targetDir(target: InstallTarget, env: NodeJS.ProcessEnv = process.env): string {
	if (target.harness === Harness.Codex) return join(env.CODEX_HOME || join(homedir(), ".codex"), "skills");
	return join(target.project ?? homedir(), ".claude", "skills");
}

/** Copies `skills/<name>` to the target and returns the new directory. `name` must be a bundled skill. */
export function installSkill(skillsRoot: string, name: string, target: InstallTarget, env: NodeJS.ProcessEnv = process.env): string {
	if (!listSkills(skillsRoot).includes(name)) throw new Error(`unknown skill "${name}"; \`rine-herdr skills list\` shows the bundled ones`);
	const dest = join(targetDir(target, env), name);
	cpSync(join(skillsRoot, name), dest, { recursive: true });
	return dest;
}
