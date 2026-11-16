// launcher.ts — the executable a harness runs as its MCP server. Herdr moves a plugin's install dir on
// every reinstall, so the daemon rewrites this file at each start, and harnesses register this stable path.
import { chmodSync } from "node:fs";
import { writeAtomic } from "@rine-network/core";
import { launcherEntry } from "../cli/root.js";
import { statePaths } from "../identity/paths.js";

const LAUNCHER_MODE = 0o700;

/** Single-quotes `value` for `sh`. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function launcherScript(node: string, installRoot: string, stateDir: string): string {
	return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(launcherEntry(installRoot))} mcp --state-dir ${shellQuote(stateDir)}\n`;
}

/** Writes the launcher for this install and returns its path. */
export function writeLauncher(stateDir: string, installRoot: string, node: string = process.execPath): string {
	const { launcher } = statePaths(stateDir);
	writeAtomic(launcher, launcherScript(node, installRoot, stateDir));
	chmodSync(launcher, LAUNCHER_MODE);
	return launcher;
}
