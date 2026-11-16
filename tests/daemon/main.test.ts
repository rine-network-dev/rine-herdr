import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonExit, runDaemon, UNREACHABLE_EXIT_MS } from "../../src/daemon/main.js";
import { StatusResult } from "../../src/daemon/ipc-schemas.js";
import { ipcCall } from "../../src/daemon/ipc.js";
import { statePaths } from "../../src/identity/paths.js";
import { IpcMethod } from "../../src/types.js";
import { FakePort } from "../herdr/fake-port.js";
import { HOST } from "./fixtures.js";

/** Lets real I/O (the unix socket) and promise callbacks run while setTimeout stays faked. */
async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
	expect(cond()).toBe(true);
}

describe("runDaemon", () => {
	let dir: string;
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		dir = mkdtempSync(join(tmpdir(), "rh-main-"));
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	const start = (port: FakePort, extra: Partial<Parameters<typeof runDaemon>[0]> = {}) => {
		const paths = statePaths(dir);
		const logs: string[] = [];
		const done = runDaemon({
			paths,
			host: HOST,
			port,
			source: async function* () {},
			log: (l) => void logs.push(l),
			pid: process.pid,
			home: dir,
			...extra,
		});
		return { paths, logs, done };
	};

	it("runDaemon_whileAnotherRuns_exitsAlreadyRunningAndLeavesTheFirstAlone", async () => {
		const port = new FakePort();
		const stop = new AbortController();
		const first = start(port, { rewriteLauncher: vi.fn(), signal: stop.signal });
		await until(() => existsSync(first.paths.sock) && port.sockets.length > 0);
		const rewrite = vi.fn();
		const second = start(new FakePort(), { rewriteLauncher: rewrite });
		await expect(second.done).resolves.toBe(DaemonExit.AlreadyRunning);
		expect(rewrite).not.toHaveBeenCalled();
		expect(existsSync(first.paths.pid)).toBe(true);
		const status = await ipcCall(first.paths.sock, IpcMethod.Status, {}, StatusResult);
		expect(status).toMatchObject({ pid: process.pid, herdrConnected: true });
		stop.abort();
		await expect(first.done).resolves.toBe(DaemonExit.Stopped);
	});

	it("runDaemon_herdrUnreachableFor30s_exitsAndRemovesPidfileAndSocket", async () => {
		const port = new FakePort();
		const rewrite = vi.fn();
		const d = start(port, { rewriteLauncher: rewrite });
		await until(() => existsSync(d.paths.sock) && port.sockets.length > 0);
		expect(rewrite).toHaveBeenCalledOnce();
		port.reachable = false;
		for (const s of port.sockets) s.dropped();
		await vi.advanceTimersByTimeAsync(UNREACHABLE_EXIT_MS - 1_000);
		expect(existsSync(d.paths.pid)).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(d.done).resolves.toBe(DaemonExit.HerdrGone);
		expect(existsSync(d.paths.pid)).toBe(false);
		expect(existsSync(d.paths.sock)).toBe(false);
	});

	it("runDaemon_herdrComesBackWithin30s_keepsRunningUntilStopped", async () => {
		const port = new FakePort();
		const stop = new AbortController();
		const d = start(port, { signal: stop.signal });
		await until(() => existsSync(d.paths.sock) && port.sockets.length > 0);
		port.reachable = false;
		for (const s of port.sockets) s.dropped();
		await vi.advanceTimersByTimeAsync(10_000);
		port.reachable = true;
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(UNREACHABLE_EXIT_MS * 2);
		expect(existsSync(d.paths.pid)).toBe(true);
		stop.abort();
		await expect(d.done).resolves.toBe(DaemonExit.Stopped);
		expect(existsSync(d.paths.pid)).toBe(false);
		expect(existsSync(d.paths.sock)).toBe(false);
	});

	it("runDaemon_neverReachesHerdr_exitsAfterThe30sGrace", async () => {
		const port = new FakePort();
		port.reachable = false;
		const d = start(port);
		await until(() => existsSync(d.paths.sock));
		await vi.advanceTimersByTimeAsync(UNREACHABLE_EXIT_MS);
		await expect(d.done).resolves.toBe(DaemonExit.HerdrGone);
	});

	it("runDaemon_stalePidfile_isTakenOver", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "daemon.pid"), "999999\n");
		const stop = new AbortController();
		const d = start(new FakePort(), { alive: () => false, signal: stop.signal });
		await until(() => existsSync(d.paths.sock));
		expect(readFileSync(d.paths.pid, "utf8")).toBe(`${process.pid}\n`);
		stop.abort();
		await expect(d.done).resolves.toBe(DaemonExit.Stopped);
	});
});
