// action.ts — `rine-herdr action <id>`: what the manifest's actions run, with herdr's context in the env.
import { herdrEndpoint, actionContext } from "../../herdr/env.js";
import { HerdrSound, notify, openPane } from "../../herdr/cli.js";
import { type HerdrPort, realHerdrPort } from "../../herdr/port.js";
import { resolveStateDir, statePaths } from "../../identity/paths.js";
import { PaneView, paneLaunchEnv } from "../../pane/env.js";
import { type DaemonClient, daemonClient } from "../daemon-client.js";
import type { CliIo } from "../io.js";
import { bindPane, unbindPane } from "./bind.js";

export const PLUGIN_ID = "rine-herdr";
const PANE_ENTRYPOINT = "rine";

export interface ActionDeps {
	port: HerdrPort;
	client: DaemonClient;
	env: NodeJS.ProcessEnv;
}

type Action = (deps: ActionDeps, io: CliIo) => Promise<number>;

/** An action has no terminal: what it prints also goes to herdr as a toast. */
function toasting(deps: ActionDeps, io: CliIo): CliIo {
	const toast = (line: string, sound?: HerdrSound): void => void notify(deps.port, { title: "rine", body: line, sound }).catch(() => {});
	return { ...io, out: (line) => (io.out(line), toast(line)), err: (line) => (io.err(line), toast(line, HerdrSound.Request)) };
}

const onFocusedPane =
	(run: (deps: ActionDeps, paneId: string, io: CliIo) => Promise<number>): Action =>
	async (deps, io) => {
		const paneId = actionContext(deps.env).focusedPaneId;
		if (paneId === null) {
			io.err("no focused pane in the action context");
			return 2;
		}
		return run(deps, paneId, toasting(deps, io));
	};

const openAt =
	(view: PaneView): Action =>
	async (deps) => {
		const ctx = actionContext(deps.env);
		const repoRoot = ctx.repoRoot ?? ctx.workspaceCwd;
		await openPane(deps.port, {
			plugin: PLUGIN_ID,
			entrypoint: PANE_ENTRYPOINT,
			cwd: repoRoot ?? undefined,
			env: paneLaunchEnv({ focusedPane: ctx.focusedPaneId, repoRoot, view }),
		});
		return 0;
	};

/** One dispatcher per `[[actions]]` id in the manifest; a unit test holds the two lists equal. */
export const ACTIONS = {
	bind: onFocusedPane((deps, paneId, io) => bindPane(deps.client, paneId, undefined, io)),
	unbind: onFocusedPane((deps, paneId, io) => unbindPane(deps.client, paneId, io)),
	open: openAt(PaneView.Menu),
	apply: openAt(PaneView.Plan),
} as const satisfies Record<string, Action>;

export async function runAction(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const id = argv[0];
	const action = Object.entries(ACTIONS).find(([name]) => name === id)?.[1];
	if (action === undefined) {
		io.err(`unknown action "${id ?? ""}"; known: ${Object.keys(ACTIONS).join(", ")}`);
		return 2;
	}
	return action(
		{ port: realHerdrPort(herdrEndpoint(env), env), client: daemonClient(statePaths(resolveStateDir(env)).sock), env },
		io,
	);
}
