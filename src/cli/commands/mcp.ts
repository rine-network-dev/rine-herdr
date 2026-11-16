// mcp.ts — `rine-herdr mcp --state-dir DIR`: what the launcher script runs. The shim does the work.
import { parseArgs } from "node:util";
import { resolveStateDir } from "../../identity/paths.js";
import { runShim } from "../../mcp/shim.js";

export async function runMcp(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options: { "state-dir": { type: "string" } }, strict: true });
	return runShim(values["state-dir"] ?? resolveStateDir(env), env);
}
