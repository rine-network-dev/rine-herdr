// pane.ts — `rine-herdr pane`: the popup the manifest's [[panes]] entry runs.
import { daemonClient } from "../daemon-client.js";
import { herdrEndpoint } from "../../herdr/env.js";
import { realHerdrPort } from "../../herdr/port.js";
import { resolveStateDir, statePaths } from "../../identity/paths.js";
import { realRegisterDeps } from "../../mcp/register.js";
import { paneStart } from "../../pane/env.js";
import { createScreens } from "../../pane/screens.js";
import { runPane } from "../../pane/tui.js";
import { packageRoot, skillsDir } from "../root.js";

export function runPaneCommand(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const stateDir = resolveStateDir(env);
	return runPane({
		input: process.stdin,
		output: process.stdout,
		start: paneStart(env, process.cwd()),
		screens: (ask, io) =>
			createScreens(
				{
					client: daemonClient(statePaths(stateDir).sock),
					port: realHerdrPort(herdrEndpoint(env), env),
					start: paneStart(env, process.cwd()),
					stateDir,
					skillsRoot: skillsDir(packageRoot()),
					env,
					registerDeps: realRegisterDeps(io.out),
				},
				ask,
				io,
			),
	});
}
