import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquirePidfile, detachDaemon, pidIsAlive, runningDaemon, type Spawn } from "../../src/daemon/process.js";
import { startDaemon } from "../../src/daemon/main.js";
import { statePaths } from "../../src/identity/paths.js";

describe("daemon process", () => {
	let dir: string;
	let pid: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rh-proc-"));
		pid = join(dir, "daemon.pid");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("acquirePidfile_freeFile_isHeldAndReleaseRemovesIt", () => {
		const lock = acquirePidfile(pid, 4242);
		expect(lock.held).toBe(true);
		expect(readFileSync(pid, "utf8")).toBe("4242\n");
		if (lock.held) lock.release();
		expect(existsSync(pid)).toBe(false);
	});

	it("acquirePidfile_liveHolder_isRefusedWithItsPid", () => {
		acquirePidfile(pid, 4242);
		expect(acquirePidfile(pid, 5000, () => true)).toEqual({ held: false, pid: 4242 });
		expect(readFileSync(pid, "utf8")).toBe("4242\n");
	});

	it("acquirePidfile_deadHolder_isTakenOver", () => {
		writeFileSync(pid, "4242\n");
		const lock = acquirePidfile(pid, 5000, () => false);
		expect(lock.held).toBe(true);
		expect(readFileSync(pid, "utf8")).toBe("5000\n");
	});

	it("acquirePidfile_garbageContent_isTakenOver", () => {
		writeFileSync(pid, "not a pid");
		expect(acquirePidfile(pid, 5000, () => true).held).toBe(true);
	});

	it("runningDaemon_reportsOnlyALiveHolder", () => {
		expect(runningDaemon(pid)).toBeNull();
		writeFileSync(pid, `${process.pid}\n`);
		expect(runningDaemon(pid)).toBe(process.pid);
		expect(runningDaemon(pid, () => false)).toBeNull();
	});

	it("pidIsAlive_thisProcessIsAlive_andAnImpossiblePidIsNot", () => {
		expect(pidIsAlive(process.pid)).toBe(true);
		expect(pidIsAlive(2 ** 22 + 12345)).toBe(false);
	});

	it("detachDaemon_spawnsDetachedWithLogStdioAndUnrefs", () => {
		const unref = vi.fn();
		const spawn = vi.fn(() => ({ pid: 777, unref }));
		const log = join(dir, "daemon.log");
		expect(detachDaemon("/x/cli.js", ["daemon", "run"], log, spawn as unknown as Spawn)).toBe(777);
		const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { detached: boolean; stdio: unknown[] }];
		expect(command).toBe(process.execPath);
		expect(args).toEqual(["/x/cli.js", "daemon", "run"]);
		expect(options.detached).toBe(true);
		expect(options.stdio[0]).toBe("ignore");
		expect(options.stdio[1]).toBe(options.stdio[2]);
		expect(unref).toHaveBeenCalledOnce();
		expect(existsSync(log)).toBe(true);
	});

	it("startDaemon_alreadyRunning_spawnsNothing", () => {
		const paths = statePaths(dir);
		writeFileSync(paths.pid, `${process.pid}\n`);
		const spawnFn = vi.fn();
		expect(startDaemon({ paths, entry: "/x/cli.js", spawnFn: spawnFn as unknown as Spawn })).toEqual({ started: false, pid: process.pid });
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("startDaemon_noDaemon_spawnsOneWithDaemonRun", () => {
		const paths = statePaths(dir);
		const spawnFn = vi.fn((_command: string, _args: string[]) => ({ pid: 9, unref() {} }));
		expect(startDaemon({ paths, entry: "/x/cli.js", spawnFn: spawnFn as unknown as Spawn })).toEqual({ started: true, pid: 9 });
		expect(spawnFn.mock.calls[0]?.[1]).toEqual(["/x/cli.js", "daemon", "run"]);
	});
});
