import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startIpcServer } from "../../src/daemon/ipc.js";
import { statePaths } from "../../src/identity/paths.js";
import { runShim, shimEnv } from "../../src/mcp/shim.js";
import { type Binding, BindingState, IpcMethod } from "../../src/types.js";
import { binding } from "./fixtures.js";

const HOST = { apiUrl: "https://api.test.rine" };
const IN_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", PATH: "/usr/bin" };

describe("shimEnv", () => {
	it("replaces an inherited owner dir and drops every inherited RINE_ variable", () => {
		const env = shimEnv(
			{ ...IN_PANE, RINE_OWNER_DIR: "/real/owner", RINE_TOKEN: "x", RINE_AGENT: "other", RINE_OPERATOR_SIGNING_KEY: "k", RINE_API_URL: "https://evil" },
			binding(BindingState.Applied, ["rine_whoami"]),
			HOST,
			"/state",
		);
		expect(env.RINE_OWNER_DIR).toBe("/state/empty-owner");
		expect(env.RINE_API_URL).toBe(HOST.apiUrl);
		expect(env.RINE_CONFIG_DIR).toBe("/state/agents/0123456789abcdef");
		expect(Object.keys(env).filter((k) => k.startsWith("RINE_")).sort()).toEqual(
			["RINE_API_URL", "RINE_CONFIG_DIR", "RINE_MCP_TOOLS", "RINE_OWNER_DIR"],
		);
		expect(env.PATH).toBe("/usr/bin");
	});

	it.each([
		["an applied binding", IN_PANE, binding(BindingState.Applied, ["rine_whoami", "rine_send"]), "rine_whoami,rine_send"],
		["a pending binding", IN_PANE, binding(BindingState.PendingApply, ["rine_whoami"]), ""],
		["an unbound binding", IN_PANE, binding(BindingState.Unbound, ["rine_whoami"]), ""],
		["no binding", IN_PANE, null, ""],
		["a process outside herdr", { PATH: "/usr/bin" }, binding(BindingState.Applied, ["rine_whoami"]), ""],
		["HERDR_ENV unset", { HERDR_PANE_ID: "w1:p1" }, binding(BindingState.Applied, ["rine_whoami"]), ""],
		["no pane id", { HERDR_ENV: "1" }, binding(BindingState.Applied, ["rine_whoami"]), ""],
	])("exposes the tools for %s as %j", (_label, inherited, b, tools) => {
		expect(shimEnv(inherited, b, HOST, "/state").RINE_MCP_TOOLS).toBe(tools);
	});
});

describe("shimEnv no-tools reason", () => {
	const reason = (inherited: NodeJS.ProcessEnv, b: Binding | null) => shimEnv(inherited, b, HOST, "/state").RINE_MCP_NO_TOOLS_NOTE;

	it("says the policy is not applied yet, and names the command, for a pending binding", () => {
		expect(reason(IN_PANE, binding(BindingState.PendingApply, ["rine_whoami"]))).toMatch(/policy has not been applied yet: run `rine-herdr apply`/);
	});

	it.each([
		["an unbound binding", IN_PANE, binding(BindingState.Unbound, [])],
		["no binding", IN_PANE, null],
	])("says to bind the pane for %s", (_label, inherited, b) => {
		expect(reason(inherited, b)).toMatch(/not bound to a rine agent: run `rine-herdr bind`/);
	});

	it("says it is not a herdr pane outside herdr", () => {
		expect(reason({ PATH: "/usr/bin" }, binding(BindingState.Applied, ["rine_whoami"]))).toMatch(/not a herdr pane/);
	});

	it("adds no reason when the tools are on", () => {
		expect(reason(IN_PANE, binding(BindingState.Applied, ["rine_whoami"]))).toBeUndefined();
	});
});

describe("shimEnv tool allowlist", () => {
	it("drops a tool outside the herdr allowlist that a binding record carries", () => {
		const widened = { ...binding(BindingState.Applied, ["rine_whoami"]), tools: ["rine_whoami", "rine_pay", "rine_admin"] } as unknown as Binding;
		expect(shimEnv(IN_PANE, widened, HOST, "/state").RINE_MCP_TOOLS).toBe("rine_whoami");
	});
});

describe("runShim", () => {
	it("refuses to run when empty-owner holds a file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-shim-"));
		try {
			spawnSync("mkdir", ["-p", statePaths(dir).emptyOwner]);
			spawnSync("touch", [join(statePaths(dir).emptyOwner, "root.key")]);
			await expect(runShim(dir, IN_PANE)).rejects.toThrow(/must stay empty/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Speaks MCP over stdio to the real shim process and returns the tool names it lists. */
async function listedTools(stateDir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
	const child: ChildProcess = spawn(process.execPath, ["bin/rine-herdr.js", "mcp", "--state-dir", stateDir], {
		env: { PATH: process.env.PATH, ...env },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const answer = new Promise<string[]>((resolve, reject) => {
		child.once("error", reject);
		createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
			const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
			if (msg.id === 2) resolve((msg.result?.tools ?? []).map((t) => t.name));
		});
	});
	const send = (m: object): void => void child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
	send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
	send({ method: "notifications/initialized" });
	send({ id: 2, method: "tools/list" });
	try {
		return (await answer).sort();
	} finally {
		child.kill();
	}
}

describe("the shim process", () => {
	let dir: string;
	beforeAll(() => {
		const build = spawnSync("npm", ["run", "build"], { encoding: "utf8" });
		if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
	}, 120_000);
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "herdr-shim-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("lists no tools when no daemon runs", async () => {
		expect(await listedTools(dir, IN_PANE)).toEqual([]);
	});

	it.each([
		[BindingState.PendingApply, []],
		[BindingState.Applied, ["rine_inbox", "rine_whoami"]],
	])("lists the tools of a %s binding", async (state, expected) => {
		const paths = statePaths(dir);
		spawnSync("mkdir", ["-p", paths.root]);
		const server = await startIpcServer(
			paths.sock,
			async (request) => {
				expect(request.method).toBe(IpcMethod.ForPane);
				return { binding: binding(state, ["rine_whoami", "rine_inbox"], join(dir, "agent")) };
			},
			() => {},
		);
		try {
			expect(await listedTools(dir, { ...IN_PANE, RINE_TOKEN: "leaked", RINE_OWNER_DIR: "/real/owner" })).toEqual([...expected].sort());
		} finally {
			await server.close();
		}
	});

	it("ends a running server once its pane is unbound", async () => {
		const paths = statePaths(dir);
		spawnSync("mkdir", ["-p", paths.root]);
		let asked = 0;
		const server = await startIpcServer(
			paths.sock,
			async () => {
				asked += 1;
				return { binding: binding(asked === 1 ? BindingState.Applied : BindingState.Unbound, ["rine_whoami"], join(dir, "agent")) };
			},
			() => {},
		);
		const child = spawn(process.execPath, ["bin/rine-herdr.js", "mcp", "--state-dir", dir], {
			env: { ...IN_PANE },
			stdio: ["pipe", "ignore", "inherit"],
		});
		try {
			const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
			await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("shim still running after unbind")), 8000))]);
			expect(asked).toBeGreaterThan(1);
		} finally {
			child.kill();
			await server.close();
		}
	}, 15_000);
});
