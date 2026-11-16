import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { ACTIONS, runAction } from "../../src/cli/commands/action.js";
import { daemonClient } from "../../src/cli/daemon-client.js";
import { type CliIo } from "../../src/cli/io.js";
import { KEYBINDING_SNIPPET, type LinkDeps, runLink } from "../../src/cli/commands/link.js";
import { runRegisterMcp } from "../../src/cli/commands/register.js";
import { packageRoot } from "../../src/cli/root.js";
import { DAEMON_DOWN, startIpcServer } from "../../src/daemon/ipc.js";
import { statePaths } from "../../src/identity/paths.js";
import { installSkill, listSkills, targetDir } from "../../src/skills/install.js";
import { Harness } from "../../src/mcp/register.js";
import { IpcMethod } from "../../src/types.js";
import { FakePort, ok } from "../herdr/fake-port.js";
import { binding } from "../mcp/fixtures.js";

const ROOT = packageRoot();
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "herdr-cli-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function capture(): CliIo & { out_: string[]; err_: string[] } {
	const out_: string[] = [];
	const err_: string[] = [];
	return { out_, err_, out: (l) => void out_.push(l), err: (l) => void err_.push(l), confirm: async () => false };
}

describe("skills install", () => {
	const skills = join(ROOT, "skills");

	it("lists the bundled skills", () => {
		expect(listSkills(skills)).toContain("rine-herdr");
	});

	it.each([
		[{ harness: Harness.ClaudeCode, project: "/p" }, "/p/.claude/skills"],
		[{ harness: Harness.Codex }, "/codex/skills"],
	])("resolves %j to %s", (target, expected) => {
		expect(targetDir(target, { CODEX_HOME: "/codex" })).toBe(expected);
	});

	it("copies SKILL.md into a project's .claude/skills", () => {
		const dest = installSkill(skills, "team-sync", { harness: Harness.ClaudeCode, project: dir });
		expect(dest).toBe(join(dir, ".claude", "skills", "team-sync"));
		expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe(readFileSync(join(skills, "team-sync", "SKILL.md"), "utf8"));
	});

	it.each(["../x", "nope", ""])("refuses the unknown skill %j", (name) => {
		expect(() => installSkill(skills, name, { harness: Harness.ClaudeCode, project: dir })).toThrow(/unknown skill/);
	});

	it("the cli installs for codex and rejects a missing target", async () => {
		const io = capture();
		const env = { CODEX_HOME: join(dir, "codex") };
		expect(await main(["skills", "install", "design-loop", "--target", "codex"], io, env)).toBe(0);
		expect(existsSync(join(dir, "codex", "skills", "design-loop", "SKILL.md"))).toBe(true);
		expect(await main(["skills", "install", "design-loop"], io, env)).toBe(2);
	});
});

describe("register-mcp", () => {
	const deps = { run: async () => 0, codexConfig: join(tmpdir(), "none.toml"), out: () => {} };

	it("shows the command one flag per line, asks about the harness and scope by name, and says to restart agents", async () => {
		const io = { ...capture(), confirm: async (q: string) => (asked.push(q), true) };
		const asked: string[] = [];
		expect(await runRegisterMcp(["--harness", "claude-code"], io, { HERDR_PLUGIN_STATE_DIR: dir }, deps)).toBe(0);
		expect(io.out_[0]).toMatch(/^this runs:\nclaude mcp add \\\n {2}--env HERDR_ENV=/);
		expect(asked).toEqual(["Register rine-herdr for Claude Code (user scope)?"]);
		expect(io.out_.at(-1)).toBe("registered; restart running agents to pick it up");
	});

	it("registers nothing when the human declines", async () => {
		const io = capture();
		expect(await runRegisterMcp(["--harness", "codex"], io, { HERDR_PLUGIN_STATE_DIR: dir }, deps)).toBe(1);
		expect(io.out_.join("\n")).not.toContain("registered");
	});
});

describe("link", () => {
	const deps = (exec: LinkDeps["exec"], port = new FakePort()): LinkDeps => ({ exec, port, pluginDir: join(dir, "plugin"), root: ROOT });

	it("copies the manifest and package.json, installs, links and prints the key snippet", async () => {
		const io = capture();
		const ran: string[][] = [];
		const port = new FakePort();
		expect(await runLink(io, deps(async (c, a, cwd) => (ran.push([c, ...a, cwd]), 0), port))).toBe(0);
		expect(readFileSync(join(dir, "plugin", "herdr-plugin.toml"), "utf8")).toContain('id = "rine-herdr"');
		expect(ran).toEqual([["npm", "install", "--omit=dev", "--no-audit", "--no-fund", join(dir, "plugin")]]);
		expect(port.calls).toEqual([["plugin", "link", join(dir, "plugin")]]);
		expect(io.out_.join("\n")).toContain(KEYBINDING_SNIPPET);
		expect(io.out_.join("\n")).toContain("~/.config/herdr/config.toml");
		expect(io.out_.at(-1)).toMatch(/Restart herdr to start the rine daemon/);
	});

	it("uses npm ci when a lock file is present", async () => {
		mkdirSync(join(dir, "plugin"));
		writeFileSync(join(dir, "plugin", "package-lock.json"), "{}");
		const ran: string[][] = [];
		await runLink(capture(), deps(async (c, a) => (ran.push([c, ...a]), 0)));
		expect(ran[0]?.[1]).toBe("ci");
	});

	it("does not link after a failed install", async () => {
		const port = new FakePort();
		expect(await runLink(capture(), deps(async () => 1, port))).toBe(1);
		expect(port.calls).toEqual([]);
	});
});

describe("actions", () => {
	const context = (extra: object = {}) => ({
		HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1:p2", workspace_cwd: "/work/repo", ...extra }),
		HERDR_SOCKET_PATH: "/nonexistent",
		HERDR_PLUGIN_STATE_DIR: dir,
	});

	it("opens the rine pane with the focused pane and repo in its env, at the menu for open and the plan for apply", async () => {
		for (const [id, view] of [["open", "menu"], ["apply", "plan"]] as const) {
			const port = new FakePort(() => ok());
			const deps = { port, client: daemonClient(statePaths(dir).sock), env: context() };
			expect(await ACTIONS[id](deps, capture())).toBe(0);
			expect(port.calls[0]).toEqual([
				"plugin", "pane", "open", "--plugin", "rine-herdr", "--entrypoint", "rine", "--cwd", "/work/repo",
				"--env", `RINE_HERDR_VIEW=${view}`, "--env", "RINE_HERDR_FOCUSED_PANE=w1:p2", "--env", "RINE_HERDR_REPO=/work/repo",
			]);
		}
	});

	it("bind and unbind act on the focused pane through the daemon and toast the result", async () => {
		const paths = statePaths(dir);
		const asked: string[] = [];
		const server = await startIpcServer(
			paths.sock,
			async (r) => {
				asked.push(`${r.method} ${(r.params as { paneId?: string }).paneId}`);
				return r.method === IpcMethod.Bind ? { binding: binding("pending_apply"), warnings: [] } : { binding: binding("unbound") };
			},
			() => {},
		);
		try {
			const port = new FakePort(() => ok());
			const deps = { port, client: daemonClient(paths.sock), env: context() };
			expect(await ACTIONS.bind(deps, capture())).toBe(0);
			expect(await ACTIONS.unbind(deps, capture())).toBe(0);
			expect(asked).toEqual(["binding.bind w1:p2", "binding.unbind w1:p2"]);
			expect(port.calling("notification", "show")).toHaveLength(2);
		} finally {
			await server.close();
		}
	});

	it("bind without a focused pane is a usage error", async () => {
		const deps = { port: new FakePort(), client: daemonClient(statePaths(dir).sock), env: { HERDR_PLUGIN_CONTEXT_JSON: "{}" } };
		expect(await ACTIONS.bind(deps, capture())).toBe(2);
	});

	it("an unknown action id is refused", async () => {
		const io = capture();
		expect(await runAction(["nope"], io, context())).toBe(2);
		expect(io.err_[0]).toContain("known: bind, unbind, open, apply");
	});
});

describe("main", () => {
	it("prints usage for no command and for an unknown one", async () => {
		const io = capture();
		expect(await main([], io)).toBe(2);
		expect(await main(["frobnicate"], io)).toBe(1);
		expect(io.err_[0]).toContain("usage: rine-herdr");
	});

	it("prints usage with a description per command, the version and the first-run order, and --help exits 0", async () => {
		for (const flag of ["--help", "-h"]) {
			const io = capture();
			expect(await main([flag], io)).toBe(0);
			const text = io.out_.join("\n");
			expect(text).toMatch(/usage: rine-herdr <command> {4}\(version \d+\.\d+\.\d+/);
			expect(text).toMatch(/first run, in this order:\n {2}init .*\n {2}link .*\n {2}bind .*\n {2}register-mcp .*\n {2}apply /);
			expect(text).toContain("take a rine identity off a pane");
		}
	});

	it("turns a thrown error into a message and exit 1", async () => {
		const io = capture();
		expect(await main(["plan"], io, { HERDR_PLUGIN_STATE_DIR: dir })).toBe(1);
		expect(io.err_.join("")).toMatch(/^error: .*rine-herdr init/);
	});

	it("bind outside a pane needs --pane", async () => {
		expect(await main(["bind"], capture(), { HERDR_PLUGIN_STATE_DIR: dir })).toBe(2);
	});

	it("daemon status reports a stopped daemon", async () => {
		const io = capture();
		expect(await main(["daemon", "status"], io, { HERDR_PLUGIN_STATE_DIR: dir })).toBe(1);
		expect(io.err_).toEqual([`error: ${DAEMON_DOWN}`]);
		expect(io.out_).toEqual([]);
	});
});

describe("daemon client", () => {
	it("round-trips the methods the shim and the pane use", async () => {
		const paths = statePaths(dir);
		const server = await startIpcServer(paths.sock, async () => ({ binding: binding("applied", ["rine_whoami"]) }), () => {});
		try {
			expect((await daemonClient(paths.sock).forPane("w1:p1"))?.tools).toEqual(["rine_whoami"]);
			await expect(daemonClient(join(dir, "none.sock")).forPane("w1:p1")).rejects.toThrow(DAEMON_DOWN);
		} finally {
			await server.close();
		}
	});
});
