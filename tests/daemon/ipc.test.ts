import { mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_DOWN, ipcCall, startIpcServer, type IpcServer } from "../../src/daemon/ipc.js";
import { ForPaneResult, StatusResult } from "../../src/daemon/ipc-schemas.js";
import { IpcMethod } from "../../src/types.js";
import { BINDING } from "./fixtures.js";

describe("daemon ipc", () => {
	let dir: string;
	let sock: string;
	let server: IpcServer | null = null;
	const logs: string[] = [];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rh-ipc-"));
		sock = join(dir, "d.sock");
	});
	afterEach(async () => {
		await server?.close();
		server = null;
		rmSync(dir, { recursive: true, force: true });
	});

	/** One raw line out, the first line back. */
	const raw = (line: string): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const conn = net.connect(sock, () => conn.write(`${line}\n`));
			conn.once("data", (d) => {
				conn.destroy();
				resolve(JSON.parse(d.toString().trim()));
			});
			conn.once("error", reject);
		});

	it("startIpcServer_createsAUserOnlySocket", async () => {
		server = await startIpcServer(sock, async () => ({}), () => {});
		expect(statSync(sock).mode & 0o777).toBe(0o600);
	});

	it("ipcCall_forPane_roundTripsAValidatedResult", async () => {
		server = await startIpcServer(sock, async (r) => (r.method === IpcMethod.ForPane ? { binding: BINDING } : {}), () => {});
		const result = await ipcCall(sock, IpcMethod.ForPane, { paneId: "w1:p1" }, ForPaneResult);
		expect(result.binding?.key).toBe(BINDING.key);
	});

	it("handlerThrows_clientGetsTheMessageAsAnError", async () => {
		server = await startIpcServer(sock, async () => Promise.reject(new Error("pane w9 runs no agent")), () => {});
		await expect(ipcCall(sock, IpcMethod.ForPane, { paneId: "w9" }, ForPaneResult)).rejects.toThrow("pane w9 runs no agent");
	});

	it("handlerReturnsMalformedResult_clientGetsInternalErrorAndTheServerLogs", async () => {
		server = await startIpcServer(sock, async () => ({ pid: "nope" }), (l) => void logs.push(l));
		await expect(ipcCall(sock, IpcMethod.Status, {}, StatusResult)).rejects.toThrow("internal error");
		expect(logs.some((l) => l.includes("malformed result"))).toBe(true);
	});

	it("invalidRequest_isRefusedWithoutCallingTheHandler", async () => {
		let called = 0;
		server = await startIpcServer(sock, async () => void (called += 1), () => {});
		expect(await raw(JSON.stringify({ id: 7, method: "binding.forPane", params: {} }))).toEqual({ id: 7, ok: false, error: "invalid request" });
		expect(await raw(JSON.stringify({ id: 8, method: "rm.rf", params: {} }))).toMatchObject({ ok: false });
		expect(await raw("not json")).toEqual({ id: -1, ok: false, error: "request is not json" });
		expect(called).toBe(0);
	});

	it("ipcCall_noServer_saysTheDaemonIsNotRunningAndHowToStartIt", async () => {
		await expect(ipcCall(sock, IpcMethod.Status, {}, StatusResult)).rejects.toThrow(DAEMON_DOWN);
	});

	it("startIpcServer_staleSocketFile_isReplaced", async () => {
		const first = await startIpcServer(sock, async () => ({}), () => {});
		await first.close();
		server = await startIpcServer(sock, async () => ({ binding: null }), () => {});
		await expect(ipcCall(sock, IpcMethod.ForPane, { paneId: "p" }, ForPaneResult)).resolves.toEqual({ binding: null });
	});
});
