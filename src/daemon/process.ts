// process.ts — what makes the daemon a single background process: an exclusive pidfile with stale-pid
// takeover, and the detached spawn of `daemon run`.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { createAtomicExclusive } from "@rine-network/core";

export function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type Lock = { held: true; release(): void } | { held: false; pid: number | null };

function readPid(path: string): number | null {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** Takes the pidfile, or reports the live process that holds it. A pidfile of a dead process is taken over. */
export function acquirePidfile(path: string, pid: number, alive: (pid: number) => boolean = pidIsAlive): Lock {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (createAtomicExclusive(path, `${pid}\n`)) return { held: true, release: () => rmSync(path, { force: true }) };
		const holder = readPid(path);
		if (holder !== null && alive(holder)) return { held: false, pid: holder };
		rmSync(path, { force: true });
	}
	return { held: false, pid: readPid(path) };
}

/** The pid of the running daemon, or null. */
export function runningDaemon(pidPath: string, alive: (pid: number) => boolean = pidIsAlive): number | null {
	const pid = readPid(pidPath);
	return pid !== null && alive(pid) ? pid : null;
}

export type Spawn = (command: string, args: string[], options: { detached: true; stdio: ["ignore", number, number] }) => Pick<ChildProcess, "pid" | "unref">;

/** Starts `<entry> daemon run` detached, its output going to the daemon log. Returns the child's pid. */
export function detachDaemon(entry: string, args: readonly string[], logPath: string, run: Spawn = spawn): number | null {
	const fd = openSync(logPath, "a", 0o600);
	try {
		const child = run(process.execPath, [entry, ...args], { detached: true, stdio: ["ignore", fd, fd] });
		child.unref();
		return child.pid ?? null;
	} finally {
		closeSync(fd);
	}
}
