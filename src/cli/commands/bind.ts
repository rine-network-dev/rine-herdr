// bind.ts — `rine-herdr bind` and `unbind`: give a pane a rine identity, or take it away, through the daemon.
import { parseArgs } from "node:util";
import { paneEnv } from "../../herdr/env.js";
import { resolveStateDir, statePaths } from "../../identity/paths.js";
import { herdrAgentName } from "../../types.js";
import { type DaemonClient, daemonClient } from "../daemon-client.js";
import type { CliIo } from "../io.js";

const options = { pane: { type: "string" }, name: { type: "string" } } as const;

export const BIND_USAGE = "rine-herdr bind [--pane ID] [--name N]  |  rine-herdr unbind [--pane ID]";

export async function bindPane(client: DaemonClient, paneId: string, name: string | undefined, io: CliIo): Promise<number> {
	try {
		const { binding, warnings } = await client.bind(paneId, name);
		for (const warning of warnings) io.err(`warning: ${warning}`);
		io.out(`${binding.handle} is bound to this pane (${binding.state}); run \`rine-herdr apply\` to set its policy`);
		return 0;
	} catch (err) {
		io.err((err as Error).message);
		return 1;
	}
}

export async function unbindPane(client: DaemonClient, paneId: string, io: CliIo): Promise<number> {
	try {
		const binding = await client.unbind(paneId);
		io.out(binding === null ? "this pane has no rine identity" : `${binding.handle} is unbound; its agent and threads stay`);
		return 0;
	} catch (err) {
		io.err((err as Error).message);
		return 1;
	}
}

function target(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv) {
	const { values } = parseArgs({ args: [...argv], options, strict: true });
	const paneId = values.pane ?? paneEnv(env)?.paneId;
	if (!paneId) {
		io.err(`no pane: run this in a herdr pane or pass --pane\nusage: ${BIND_USAGE}`);
		return null;
	}
	return { paneId, name: values.name, client: daemonClient(statePaths(resolveStateDir(env)).sock) };
}

export async function runBind(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const t = target(argv, io, env);
	if (t === null) return 2;
	if (t.name !== undefined && !herdrAgentName.safeParse(t.name).success) {
		io.err("--name must match [a-z][a-z0-9_-]{0,31}");
		return 2;
	}
	return bindPane(t.client, t.paneId, t.name, io);
}

export async function runUnbind(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const t = target(argv, io, env);
	return t === null ? 2 : unbindPane(t.client, t.paneId, io);
}
