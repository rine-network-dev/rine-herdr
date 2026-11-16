// shim.ts — the MCP server a pane's harness talks to. It runs the published rine MCP server with an
// environment built here: the pane agent's own config dir, an empty owner dir, and the binding's tools.
// Whatever the harness or the shell inherited that could act as the org or another agent is dropped.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiUrl } from "@rine-network/core";
import { NO_TOOLS_NOTE_ENV, TOOLS_ENV } from "@rine-network/mcp/tools";
import { daemonClient } from "../cli/daemon-client.js";
import { paneEnv } from "../herdr/env.js";
import { loadHost } from "../identity/branch-init.js";
import { ensureStateDirs, statePaths } from "../identity/paths.js";
import { isExposableTool } from "../tool-profiles.js";
import { type Binding, BindingState, type Host } from "../types.js";

const RINE_PREFIX = "RINE_";
const NO_IDENTITY_DIR = "no-identity";
const UNBIND_POLL_MS = 2000;

/** Why a pane has no rine tools, in the words the agent is shown: what is missing and the command that supplies it. */
function noToolsReason(inPane: boolean, binding: Binding | null): string {
	if (!inPane) return "This process is not a herdr pane, so rine-herdr gives it no tools.";
	if (binding?.state === BindingState.PendingApply) {
		return "This pane is bound to a rine agent, but the policy has not been applied yet: run `rine-herdr apply`, then restart the agent.";
	}
	return "This pane is not bound to a rine agent: run `rine-herdr bind` in it, then `rine-herdr apply`.";
}

/**
 * The environment of the MCP server. Zero tools unless this is a herdr pane whose binding is applied.
 * The binding's tools are intersected with the herdr allowlist, so a record carrying more never widens the server.
 * Pure: it reads nothing but its arguments.
 */
export function shimEnv(
	inherited: NodeJS.ProcessEnv,
	binding: Binding | null,
	host: Pick<Host, "apiUrl">,
	stateDir: string,
): NodeJS.ProcessEnv {
	const paths = statePaths(stateDir);
	const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith(RINE_PREFIX)));
	const inPane = inherited.HERDR_ENV === "1" && Boolean(inherited.HERDR_PANE_ID);
	const live = inPane && binding?.state === BindingState.Applied ? binding : null;
	return {
		...env,
		RINE_CONFIG_DIR: binding?.configDir ?? join(paths.root, NO_IDENTITY_DIR),
		RINE_OWNER_DIR: paths.emptyOwner,
		RINE_API_URL: host.apiUrl,
		[TOOLS_ENV]: live?.tools.filter(isExposableTool).join(",") ?? "",
		...(live ? {} : { [NO_TOOLS_NOTE_ENV]: noToolsReason(inPane, binding) }),
	};
}

async function bindingOfThisPane(env: NodeJS.ProcessEnv, sock: string): Promise<Binding | null> {
	const pane = paneEnv(env);
	if (pane === null) return null;
	try {
		return await daemonClient(sock).forPane(pane.paneId);
	} catch {
		return null;
	}
}

/**
 * Stops `child` once the daemon reports this pane's binding gone or no longer applied, so an unbind ends the tools
 * of a running server instead of only those of the next launch. A daemon that does not answer changes nothing:
 * its absence is not an unbind. Returns the function that ends the watch.
 */
function stopOnUnbind(child: ChildProcess, env: NodeJS.ProcessEnv, sock: string): () => void {
	const pane = paneEnv(env);
	if (pane === null) return () => {};
	const timer = setInterval(() => {
		daemonClient(sock)
			.forPane(pane.paneId)
			.then(
				(current) => {
					if (current?.state !== BindingState.Applied) child.kill("SIGTERM");
				},
				() => {},
			);
	}, UNBIND_POLL_MS);
	return () => clearInterval(timer);
}

/** The apiUrl of the host, or the default when `init` has not run (the server then has no tools anyway). */
function apiUrlOf(stateDir: string): Pick<Host, "apiUrl"> {
	try {
		return loadHost(statePaths(stateDir));
	} catch {
		return { apiUrl: resolveApiUrl() };
	}
}

/** Runs the rine MCP server for this pane over inherited stdio and resolves with its exit code. */
export async function runShim(stateDir: string, inherited: NodeJS.ProcessEnv = process.env): Promise<number> {
	const paths = statePaths(stateDir);
	ensureStateDirs(paths); // refuses when empty-owner holds anything
	mkdirSync(join(paths.root, NO_IDENTITY_DIR), { recursive: true, mode: 0o700 });
	const binding = await bindingOfThisPane(inherited, paths.sock);
	const env = shimEnv(inherited, binding, apiUrlOf(stateDir), stateDir);
	const entry = fileURLToPath(import.meta.resolve("@rine-network/mcp"));
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [entry], { env, stdio: "inherit" });
		const stopWatching = binding?.state === BindingState.Applied ? stopOnUnbind(child, inherited, paths.sock) : () => {};
		child.on("error", () => {
			stopWatching();
			resolve(1);
		});
		child.on("close", (code) => {
			stopWatching();
			resolve(code ?? 1);
		});
	});
}
