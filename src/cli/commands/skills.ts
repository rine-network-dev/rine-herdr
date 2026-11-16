// skills.ts — `rine-herdr skills list` and `skills install <name> --target claude-code|codex [--project DIR]`.
import { parseArgs } from "node:util";
import { Harness } from "../../mcp/register.js";
import { installSkill, listSkills } from "../../skills/install.js";
import type { CliIo } from "../io.js";
import { packageRoot, skillsDir } from "../root.js";

export const SKILLS_USAGE = "rine-herdr skills list | install <name> --target claude-code|codex [--project DIR]";

export function runSkills(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): number {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: { target: { type: "string" }, project: { type: "string" } },
		allowPositionals: true,
		strict: true,
	});
	const root = skillsDir(packageRoot());
	if (positionals[0] === "list") {
		listSkills(root).forEach((name) => io.out(name));
		return 0;
	}
	const harness = Object.values(Harness).find((h) => h === values.target);
	const name = positionals[1];
	if (positionals[0] !== "install" || !name || harness === undefined) {
		io.err(`usage: ${SKILLS_USAGE}`);
		return 2;
	}
	io.out(`installed ${name} at ${installSkill(root, name, { harness, project: values.project }, env)}`);
	return 0;
}
