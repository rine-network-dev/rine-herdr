// register.ts — `rine-herdr register-mcp --harness claude-code|codex [--yes]`: put the pane launcher into a
// harness's MCP servers. It shows the command first and runs it only when the human agrees.
import { parseArgs } from "node:util";
import { resolveStateDir, statePaths } from "../../identity/paths.js";
import { HARNESS_LABEL, Harness, multilineCommand, realRegisterDeps, registerMcp, registrationCommand, type RegisterDeps } from "../../mcp/register.js";
import type { CliIo } from "../io.js";

export const REGISTER_USAGE = "rine-herdr register-mcp --harness claude-code|codex [--yes]";

export async function runRegisterMcp(
	argv: readonly string[],
	io: CliIo,
	env: NodeJS.ProcessEnv = process.env,
	deps: RegisterDeps = realRegisterDeps(io.out),
): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options: { harness: { type: "string" }, yes: { type: "boolean" } }, strict: true });
	const harness = Object.values(Harness).find((h) => h === values.harness);
	if (harness === undefined) {
		io.err(`--harness must be claude-code or codex\nusage: ${REGISTER_USAGE}`);
		return 2;
	}
	const launcher = statePaths(resolveStateDir(env)).launcher;
	io.out(`this runs:\n${multilineCommand(registrationCommand(harness, launcher))}`);
	if (!values.yes && !(await io.confirm(`Register rine-herdr for ${HARNESS_LABEL[harness]}?`))) {
		io.err("not registered; pass --yes to register without asking");
		return 1;
	}
	const code = await registerMcp(harness, launcher, deps);
	if (code === 0) io.out("registered; restart running agents to pick it up");
	return code;
}
