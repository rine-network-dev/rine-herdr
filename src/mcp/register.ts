// register.ts — registers the pane launcher as an MCP server in a harness, after the human agrees.
// The launcher needs two herdr variables from the harness's own environment to know which pane it serves.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export const Harness = { ClaudeCode: "claude-code", Codex: "codex" } as const;
export type Harness = (typeof Harness)[keyof typeof Harness];

export const SERVER_NAME = "rine-herdr";
const PANE_VARS = ["HERDR_ENV", "HERDR_PANE_ID"] as const;

/**
 * Claude Code: its docs (https://code.claude.com/docs/en/mcp, read 2026-11-13) do not say that a stdio server
 * inherits Claude's environment, but they do say `env` values expand `${VAR:-default}` from it, so each variable
 * is forwarded explicitly; a session outside herdr expands to empty and the launcher then exposes no tools. The
 * server name must not follow `--env` directly (the CLI would read it as a pair), hence `--scope` after them.
 *
 * Codex: its docs (https://learn.chatgpt.com/docs/extend/mcp, read 2026-11-13) give `codex mcp add` only
 * `--env KEY=VALUE`; forwarding a variable from Codex's own environment is `env_vars` in config.toml, which the
 * command cannot set, so `registerMcp` adds it to that file after the command ran.
 */
export function registrationCommand(harness: Harness, launcherPath: string): readonly string[] {
	if (harness === Harness.Codex) return ["codex", "mcp", "add", SERVER_NAME, "--", launcherPath];
	const forwarded = PANE_VARS.flatMap((name) => ["--env", `${name}=\${${name}:-}`]);
	return ["claude", "mcp", "add", ...forwarded, "--scope", "user", "--transport", "stdio", SERVER_NAME, "--", launcherPath];
}

/** What the human is asked about: the harness, and for Claude Code the scope the command registers at. */
export const HARNESS_LABEL: Record<Harness, string> = { [Harness.ClaudeCode]: "Claude Code (user scope)", [Harness.Codex]: "Codex" };

/** The command as a shell would take it across lines: one flag with its single value per line, any further word on its own. */
export function multilineCommand(argv: readonly string[]): string {
	const lines: string[] = [];
	for (const token of argv) {
		const last = lines[lines.length - 1];
		const flagHasValue = last !== undefined && lines.length > 1 && last.startsWith("--") && last.includes(" ");
		if (token.startsWith("--") || last === undefined || flagHasValue) lines.push(token);
		else lines[lines.length - 1] += ` ${token}`;
	}
	return lines.map((line, i) => (i === 0 ? line : `  ${line}`)).join(" \\\n");
}

export const codexConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
	join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

const TABLE_HEADER = new RegExp(`^\\[mcp_servers\\.("?)${SERVER_NAME}\\1\\]\\s*$`, "m");

/** Adds `env_vars` under the server's table; false when the table is not there or the result would not parse. */
export function withCodexEnvVars(toml: string): string | null {
	const match = TABLE_HEADER.exec(toml);
	if (match === null) return null;
	const at = match.index + match[0].length;
	const line = `\nenv_vars = [${PANE_VARS.map((v) => `"${v}"`).join(", ")}]`;
	const next = toml.slice(0, at) + line + toml.slice(at);
	try {
		parse(next);
		return next;
	} catch {
		return null;
	}
}

export interface RegisterDeps {
	run(argv: readonly string[]): Promise<number>;
	codexConfig: string;
	out(line: string): void;
}

export const realRegisterDeps = (out: (line: string) => void): RegisterDeps => ({
	run: (argv) =>
		new Promise((resolve) => {
			const [command, ...args] = argv;
			const child = spawn(command ?? "", args, { stdio: "inherit" });
			child.on("error", () => resolve(127));
			child.on("close", (code) => resolve(code ?? 1));
		}),
	codexConfig: codexConfigPath(),
	out,
});

/** Runs the registration. The caller has already got the human's consent. Returns an exit code. */
export async function registerMcp(harness: Harness, launcherPath: string, deps: RegisterDeps): Promise<number> {
	const code = await deps.run(registrationCommand(harness, launcherPath));
	if (code !== 0 || harness !== Harness.Codex) return code;
	const updated = existsSync(deps.codexConfig) ? withCodexEnvVars(readFileSync(deps.codexConfig, "utf8")) : null;
	if (updated === null) {
		deps.out(`add this under [mcp_servers.${SERVER_NAME}] in ${deps.codexConfig}: env_vars = ["HERDR_ENV", "HERDR_PANE_ID"]`);
		return 1;
	}
	writeFileSync(deps.codexConfig, updated);
	return 0;
}
