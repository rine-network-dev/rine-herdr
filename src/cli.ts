// cli.ts — the bundled entry that bin/rine-herdr.js imports: maps the first argument to a command.
import { daemonClient } from "./cli/daemon-client.js";
import { resolveStateDir, statePaths } from "./identity/paths.js";
import { runAction } from "./cli/commands/action.js";
import { runApply, runPlan } from "./cli/commands/apply.js";
import { runBind, runUnbind } from "./cli/commands/bind.js";
import { runDaemonCommand } from "./cli/commands/daemon.js";
import { runInit } from "./cli/commands/init.js";
import { runLink } from "./cli/commands/link.js";
import { runMcp } from "./cli/commands/mcp.js";
import { runPaneCommand } from "./cli/commands/pane.js";
import { runRegisterMcp } from "./cli/commands/register.js";
import { runSkills } from "./cli/commands/skills.js";
import { type CliIo, stdIo } from "./cli/io.js";
import { packageRoot, packageVersion } from "./cli/root.js";

type Listing = readonly (readonly [name: string, about: string])[];

const FIRST_RUN: Listing = [
	["init", "create this machine's rine identity (once)"],
	["link", "put the plugin where herdr can load it"],
	["bind", "give the pane you are in a rine identity"],
	["register-mcp", "add the rine tools to Claude Code or Codex"],
	["apply", "set up the repo's agents from rine-herdr.toml"],
];

const OTHER: Listing = [
	["plan", "show what apply would do, changing nothing"],
	["unbind", "take a rine identity off a pane"],
	["daemon", "start, stop or inspect the background daemon"],
	["skills", "list or install the bundled skills"],
	["pane", "open the interactive rine menu"],
	["action", "run a herdr plugin action (herdr calls this)"],
	["mcp", "serve the rine tools to an agent (the launcher calls this)"],
];

const rows = (listing: Listing): string[] => listing.map(([name, about]) => `  ${name.padEnd(13)}${about}`);

const usage = (): string =>
	[
		`usage: rine-herdr <command>    (version ${packageVersion(packageRoot())})`,
		"",
		"first run, in this order:",
		...rows(FIRST_RUN),
		"",
		"after that:",
		...rows(OTHER),
	].join("\n");

export async function main(argv: readonly string[], io: CliIo = stdIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [command = "", ...rest] = argv;
	try {
		const applyDeps = () => ({ ipc: daemonClient(statePaths(resolveStateDir(env)).sock) });
		switch (command) {
			case "init":
				return await runInit(rest, io);
			case "daemon":
				return await runDaemonCommand(rest, io, env);
			case "plan":
				return await runPlan(rest, io, applyDeps());
			case "apply":
				return await runApply(rest, io, applyDeps());
			case "bind":
				return await runBind(rest, io, env);
			case "unbind":
				return await runUnbind(rest, io, env);
			case "mcp":
				return await runMcp(rest, env);
			case "register-mcp":
				return await runRegisterMcp(rest, io, env);
			case "link":
				return await runLink(io);
			case "skills":
				return runSkills(rest, io, env);
			case "action":
				return await runAction(rest, io, env);
			case "pane":
				return await runPaneCommand(env);
			case "--help":
			case "-h":
			case "help":
				io.out(usage());
				return 0;
			default:
				io.err(usage());
				return command === "" ? 2 : 1;
		}
	} catch (err) {
		io.err(`error: ${(err as Error).message}`);
		return 1;
	}
}
