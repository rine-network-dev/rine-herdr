// daemon.ts — `rine-herdr daemon start|run|stop|status`. `start --detach` is what herdr's [[startup]] runs;
// it spawns `daemon run` and returns. `start` without --detach and `run` stay in the foreground.
import { parseArgs } from "node:util";
import { DAEMON_DOWN } from "../../daemon/ipc.js";
import { runDaemon, startDaemon } from "../../daemon/main.js";
import { runningDaemon } from "../../daemon/process.js";
import { sdkStreamSource } from "../../daemon/inbound.js";
import { herdrEndpoint } from "../../herdr/env.js";
import { realHerdrPort } from "../../herdr/port.js";
import { loadHost } from "../../identity/branch-init.js";
import { type StatePaths, resolveStateDir, statePaths } from "../../identity/paths.js";
import { writeLauncher } from "../../mcp/launcher.js";
import { renderStatus } from "../../pane/views.js";
import { daemonClient } from "../daemon-client.js";
import type { CliIo } from "../io.js";
import { launcherEntry, packageRoot } from "../root.js";

export const DAEMON_USAGE = "rine-herdr daemon start [--detach] | run | stop | status";

const Sub = { Start: "start", Run: "run", Stop: "stop", Status: "status" } as const;

async function runForeground(stateDir: string, io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
	const paths = statePaths(stateDir);
	const host = loadHost(paths);
	const stop = new AbortController();
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
	await runDaemon({
		paths,
		host,
		port: realHerdrPort(herdrEndpoint(env), env),
		source: sdkStreamSource(host),
		log: (line) => io.out(`${new Date().toISOString()} ${line}`),
		rewriteLauncher: () => void writeLauncher(stateDir, packageRoot()),
		signal: stop.signal,
	});
	return 0;
}

function startDetached(paths: StatePaths, io: CliIo): number {
	loadHost(paths); // fail here, in front of the human, rather than in a detached log
	const result = startDaemon({ paths, entry: launcherEntry(packageRoot()) });
	io.out(result.started ? `daemon started (pid ${result.pid ?? "unknown"})` : `daemon already running (pid ${result.pid})`);
	return 0;
}

async function status(stateDir: string, io: CliIo): Promise<number> {
	const paths = statePaths(stateDir);
	if (runningDaemon(paths.pid) === null) {
		io.err(`error: ${DAEMON_DOWN}`);
		return 1;
	}
	io.out(renderStatus(await daemonClient(paths.sock).status()));
	return 0;
}

export async function runDaemonCommand(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const { values, positionals } = parseArgs({ args: [...argv], options: { detach: { type: "boolean" } }, allowPositionals: true, strict: true });
	const stateDir = resolveStateDir(env);
	const paths = statePaths(stateDir);
	switch (positionals[0]) {
		case Sub.Start:
			return values.detach ? startDetached(paths, io) : runForeground(stateDir, io, env);
		case Sub.Run:
			return runForeground(stateDir, io, env);
		case Sub.Stop: {
			const pid = runningDaemon(paths.pid);
			if (pid === null) io.out("daemon is not running");
			else process.kill(pid, "SIGTERM");
			return 0;
		}
		case Sub.Status:
			return status(stateDir, io);
		default:
			io.err(`usage: ${DAEMON_USAGE}`);
			return 2;
	}
}
