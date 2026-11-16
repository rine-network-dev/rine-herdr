// main.ts — the daemon process: one per state dir, started by `daemon start`, ended by herdr going away.
// It exits 0 and removes its pidfile and socket when the herdr socket stays unreachable for 30 s, or when
// told to stop. A second instance finds the pidfile held and exits 0 without doing anything.
import type { HerdrPort } from "../herdr/port.js";
import { ensureStateDirs, type StatePaths } from "../identity/paths.js";
import type { Host } from "../types.js";
import { createDaemonCore } from "./core.js";
import type { StreamSource } from "./inbound.js";
import { startIpcServer } from "./ipc.js";
import { acquirePidfile, detachDaemon, pidIsAlive, runningDaemon, type Spawn } from "./process.js";

export const UNREACHABLE_EXIT_MS = 30_000;

export interface DaemonOptions {
	paths: StatePaths;
	host: Host;
	port: HerdrPort;
	source: StreamSource;
	log(line: string): void;
	/** Rewrites the pane launcher; the entrypoint passes `writeLauncher` bound to its install root. */
	rewriteLauncher?(): void;
	/** Ends the daemon when aborted. */
	signal?: AbortSignal;
	unreachableMs?: number;
	now?: () => number;
	home?: string;
	pid?: number;
	alive?: (pid: number) => boolean;
}

export const DaemonExit = { AlreadyRunning: "already_running", HerdrGone: "herdr_gone", Stopped: "stopped" } as const;
export type DaemonExit = (typeof DaemonExit)[keyof typeof DaemonExit];

/** Runs the daemon until it has a reason to end, then cleans up and says which. */
export async function runDaemon(opts: DaemonOptions): Promise<DaemonExit> {
	const { paths, log } = opts;
	ensureStateDirs(paths);
	const lock = acquirePidfile(paths.pid, opts.pid ?? process.pid, opts.alive);
	if (!lock.held) {
		log(`daemon already running (pid ${lock.pid ?? "unknown"})`);
		return DaemonExit.AlreadyRunning;
	}
	opts.rewriteLauncher?.();

	let finish: (why: DaemonExit) => void = () => {};
	const ended = new Promise<DaemonExit>((resolve) => (finish = resolve));
	let timer: ReturnType<typeof setTimeout> | null = null;
	const watchHerdr = (connected: boolean): void => {
		if (connected && timer !== null) {
			clearTimeout(timer);
			timer = null;
		} else if (!connected && timer === null) {
			timer = setTimeout(() => finish(DaemonExit.HerdrGone), opts.unreachableMs ?? UNREACHABLE_EXIT_MS);
		}
	};

	const onRejection = (reason: unknown): void => log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
	process.on("unhandledRejection", onRejection);
	const core = createDaemonCore({ ...opts, onConnection: watchHerdr });
	const server = await startIpcServer(paths.sock, (request) => core.handle(request), log).catch((err: Error) => {
		process.off("unhandledRejection", onRejection);
		lock.release();
		throw err;
	});
	if (opts.signal?.aborted) finish(DaemonExit.Stopped);
	else opts.signal?.addEventListener("abort", () => finish(DaemonExit.Stopped), { once: true });
	watchHerdr(false);
	core.start();
	log(`daemon up, pid ${opts.pid ?? process.pid}`);

	const why = await ended;
	if (timer !== null) clearTimeout(timer);
	core.close();
	await server.close();
	process.off("unhandledRejection", onRejection);
	lock.release();
	log(`daemon down (${why})`);
	return why;
}

export interface StartOptions {
	paths: StatePaths;
	/** The cli entry file that handles `daemon run`. */
	entry: string;
	spawnFn?: Spawn;
	alive?: (pid: number) => boolean;
}

export type StartResult = { started: true; pid: number | null } | { started: false; pid: number };

/** `daemon start`: spawns the detached daemon unless one already runs. */
export function startDaemon(opts: StartOptions): StartResult {
	ensureStateDirs(opts.paths);
	const running = runningDaemon(opts.paths.pid, opts.alive ?? pidIsAlive);
	if (running !== null) return { started: false, pid: running };
	return { started: true, pid: detachDaemon(opts.entry, ["daemon", "run"], opts.paths.log, opts.spawnFn) };
}
