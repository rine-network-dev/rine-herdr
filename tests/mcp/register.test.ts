import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, type RegisterDeps, multilineCommand, registerMcp, registrationCommand, withCodexEnvVars } from "../../src/mcp/register.js";

describe("registrationCommand", () => {
	it("registers the launcher with Claude Code at user scope and forwards the pane variables", () => {
		const argv = registrationCommand(Harness.ClaudeCode, "/state/bin/rine-herdr-mcp");
		expect(argv.slice(0, 3)).toEqual(["claude", "mcp", "add"]);
		expect(argv).toContain("HERDR_PANE_ID=${HERDR_PANE_ID:-}");
		expect(argv).toContain("HERDR_ENV=${HERDR_ENV:-}");
		expect(argv.slice(argv.indexOf("--scope"), argv.indexOf("--scope") + 2)).toEqual(["--scope", "user"]);
		expect(argv.slice(-3)).toEqual(["rine-herdr", "--", "/state/bin/rine-herdr-mcp"]);
		// the server name must not directly follow an --env value
		expect(argv[argv.indexOf("rine-herdr") - 1]).not.toMatch(/^HERDR_/);
	});

	it("registers the launcher with Codex through its own command", () => {
		expect(registrationCommand(Harness.Codex, "/l")).toEqual(["codex", "mcp", "add", "rine-herdr", "--", "/l"]);
	});
});

describe("multilineCommand", () => {
	it("puts each flag with its value on its own continued line", () => {
		expect(multilineCommand(registrationCommand(Harness.ClaudeCode, "/l"))).toBe(
			[
				"claude mcp add \\",
				"  --env HERDR_ENV=${HERDR_ENV:-} \\",
				"  --env HERDR_PANE_ID=${HERDR_PANE_ID:-} \\",
				"  --scope user \\",
				"  --transport stdio \\",
				"  rine-herdr \\",
				"  -- /l",
			].join("\n"),
		);
	});
});

describe("withCodexEnvVars", () => {
	it.each(["[mcp_servers.rine-herdr]", '[mcp_servers."rine-herdr"]'])("adds env_vars under %s and keeps the file valid", (header) => {
		const out = withCodexEnvVars(`model = "x"\n\n${header}\ncommand = "/l"\n\n[mcp_servers.other]\ncommand = "o"\n`);
		const servers = (parse(out ?? "") as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers;
		expect(servers["rine-herdr"]).toEqual({ command: "/l", env_vars: ["HERDR_ENV", "HERDR_PANE_ID"] });
		expect(servers.other).toEqual({ command: "o" });
	});

	it("returns null when the server table is absent", () => {
		expect(withCodexEnvVars('[mcp_servers.other]\ncommand = "o"\n')).toBeNull();
	});
});

describe("registerMcp", () => {
	let dir: string;
	beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "herdr-register-"))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const deps = (config: string, code = 0, onRun?: () => void): RegisterDeps & { ran: string[][]; said: string[] } => {
		const ran: string[][] = [];
		const said: string[] = [];
		return { ran, said, codexConfig: config, out: (l) => void said.push(l), run: async (argv) => (ran.push([...argv]), onRun?.(), code) };
	};

	it("runs the Claude Code command and touches no file", async () => {
		const d = deps(join(dir, "config.toml"));
		expect(await registerMcp(Harness.ClaudeCode, "/l", d)).toBe(0);
		expect(d.ran).toHaveLength(1);
	});

	it("adds env_vars to the Codex config after `codex mcp add` wrote the table", async () => {
		const config = join(dir, "config.toml");
		const d = deps(config, 0, () => writeFileSync(config, '[mcp_servers.rine-herdr]\ncommand = "/l"\n'));
		expect(await registerMcp(Harness.Codex, "/l", d)).toBe(0);
		expect(readFileSync(config, "utf8")).toContain('env_vars = ["HERDR_ENV", "HERDR_PANE_ID"]');
	});

	it("tells the human what to add when the Codex table is not found", async () => {
		const d = deps(join(dir, "missing.toml"));
		expect(await registerMcp(Harness.Codex, "/l", d)).toBe(1);
		expect(d.said[0]).toContain("env_vars");
	});

	it("passes a failing command's exit code through", async () => {
		expect(await registerMcp(Harness.Codex, "/l", deps(join(dir, "c.toml"), 3))).toBe(3);
	});
});
