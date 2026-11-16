import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realHerdrPort } from "../../src/herdr/port.js";

describe("realHerdrPort", () => {
	let dir: string;
	let server: net.Server | null = null;
	beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "rh-port-"))));
	afterEach(() => {
		server?.close();
		server = null;
		rmSync(dir, { recursive: true, force: true });
	});

	it("run_nonZeroExit_isAResultWithTheCodeAndStderr", async () => {
		const port = realHerdrPort({ socketPath: null, binPath: process.execPath });
		const res = await port.run(["-e", "process.stderr.write('nope'); process.exit(3)"]);
		expect(res).toEqual({ code: 3, stdout: "", stderr: "nope" });
	});

	it("run_missingBinary_isAFailedResultNotAnException", async () => {
		const res = await realHerdrPort({ socketPath: null, binPath: join(dir, "no-such-herdr") }).run(["x"]);
		expect(res.code).not.toBe(0);
		expect(res.stderr).not.toBe("");
	});

	it("connect_withoutASocketPath_rejects", async () => {
		await expect(realHerdrPort({ socketPath: null, binPath: "herdr" }).connect()).rejects.toThrow(/HERDR_SOCKET_PATH/);
	});

	it("connect_framesLinesAcrossChunksAndReportsCloseOnce", async () => {
		const socketPath = join(dir, "herdr.sock");
		server = net.createServer((conn) => {
			conn.write('{"a":1}\n{"b"');
			setTimeout(() => conn.end(':2}\n'), 10);
		});
		await new Promise<void>((r) => server?.listen(socketPath, r));
		const socket = await realHerdrPort({ socketPath, binPath: "herdr" }).connect();
		const lines: string[] = [];
		let closes = 0;
		socket.onLine((l) => void lines.push(l));
		socket.onClose(() => void (closes += 1));
		await new Promise((r) => setTimeout(r, 60));
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
		expect(closes).toBe(1);
	});

	it("connect_unreachableSocket_rejects", async () => {
		await expect(realHerdrPort({ socketPath: join(dir, "none.sock"), binPath: "herdr" }).connect()).rejects.toThrow();
	});
});
