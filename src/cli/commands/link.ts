// link.ts — `rine-herdr link`: for an npm-only install, put the plugin where herdr can link it.
// The plugin dir holds the manifest and a private package.json that pins this package; `npm ci` there
// makes the layout the manifest's commands expect (node_modules/@rine-network/herdr/bin/rine-herdr.js).
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { herdrEndpoint } from "../../herdr/env.js";
import { type HerdrPort, realHerdrPort } from "../../herdr/port.js";
import type { CliIo } from "../io.js";
import { packageRoot } from "../root.js";

export const KEYBINDING_SNIPPET = `[[keys.command]]
key = "prefix+alt+r"
type = "plugin_action"
command = "rine-herdr.open"`;

/** Where herdr reads its keybindings; it has no command that edits them. */
export const HERDR_CONFIG = "~/.config/herdr/config.toml";

const PLUGIN_FILES = ["herdr-plugin.toml", "package.json"] as const;

export interface LinkDeps {
	/** Runs a command in `cwd`; resolves with its exit code. */
	exec(command: string, args: readonly string[], cwd: string): Promise<number>;
	port: HerdrPort;
	pluginDir: string;
	root: string;
}

export const realLinkDeps = (env: NodeJS.ProcessEnv = process.env): LinkDeps => ({
	exec: (command, args, cwd) =>
		new Promise((resolve) => {
			execFile(command, [...args], { cwd }, (error) => resolve(error === null ? 0 : typeof error.code === "number" ? error.code : 1));
		}),
	port: realHerdrPort(herdrEndpoint(env), env),
	pluginDir: join(homedir(), ".local", "share", "rine-herdr", "plugin"),
	root: packageRoot(),
});

export async function runLink(io: CliIo, deps: LinkDeps = realLinkDeps()): Promise<number> {
	mkdirSync(deps.pluginDir, { recursive: true });
	for (const file of PLUGIN_FILES) copyFileSync(join(deps.root, "plugin", file), join(deps.pluginDir, file));
	const install = existsSync(join(deps.pluginDir, "package-lock.json")) ? "ci" : "install";
	io.out(`npm ${install} in ${deps.pluginDir}`);
	if ((await deps.exec("npm", [install, "--omit=dev", "--no-audit", "--no-fund"], deps.pluginDir)) !== 0) {
		io.err("npm failed; the plugin is not linked");
		return 1;
	}
	const linked = await deps.port.run(["plugin", "link", deps.pluginDir]);
	if (linked.code !== 0) {
		io.err(`herdr plugin link failed: ${(linked.stderr || linked.stdout).trim()}`);
		return 1;
	}
	io.out(`linked. To open the rine pane with a key, add this to ${HERDR_CONFIG}:`);
	io.out(KEYBINDING_SNIPPET);
	io.out("Restart herdr to start the rine daemon; it starts one whenever herdr launches.");
	return 0;
}
