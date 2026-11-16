// paths.ts — the one place that knows where rine-herdr keeps state. Every other module asks for a path here.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR_ENV = "HERDR_PLUGIN_STATE_DIR";

export interface StatePaths {
	root: string;
	/** Runtime config dir of the branch principal. */
	branchHome: string;
	/** Parent of the per-binding agent-only config dirs. */
	agents: string;
	/** Always empty; the shim's owner dir, so no root key is ever found there. */
	emptyOwner: string;
	bin: string;
	launcher: string;
	bindings: string;
	quarantine: string;
	pid: string;
	sock: string;
	log: string;
	host: string;
	/** The policy hash of each repo's last successful apply: a review aid, never a control. */
	appliedPolicy: string;
}

/** A path as a human reads it: the home directory is written `~`. */
export function tilde(path: string): string {
	return path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;
}

/** `$HERDR_PLUGIN_STATE_DIR`, else herdr's own plugin state location for this plugin. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env[STATE_DIR_ENV] ?? join(homedir(), ".local", "state", "herdr", "plugins", "rine-herdr");
}

export function statePaths(stateDir: string): StatePaths {
	const bin = join(stateDir, "bin");
	return {
		root: stateDir,
		branchHome: join(stateDir, "branch-home"),
		agents: join(stateDir, "agents"),
		emptyOwner: join(stateDir, "empty-owner"),
		bin,
		launcher: join(bin, "rine-herdr-mcp"),
		bindings: join(stateDir, "bindings.json"),
		quarantine: join(stateDir, "quarantine.json"),
		pid: join(stateDir, "daemon.pid"),
		sock: join(stateDir, "daemon.sock"),
		log: join(stateDir, "daemon.log"),
		host: join(stateDir, "host.json"),
		appliedPolicy: join(stateDir, "applied-policy.json"),
	};
}

/** The agent-only config dir of one binding. */
export function agentDir(paths: StatePaths, key: string): string {
	return join(paths.agents, key);
}

/** `sha256(repoRoot + "\0" + herdrName)` in hex, first 16 chars. The key never contains user text. */
export function bindingKey(repoRoot: string, herdrName: string): string {
	return createHash("sha256").update(`${repoRoot}\0${herdrName}`).digest("hex").slice(0, 16);
}

/** Create every state dir at 0700. Refuses when `empty-owner` holds anything. */
export function ensureStateDirs(paths: StatePaths): void {
	for (const dir of [paths.root, paths.branchHome, paths.agents, paths.emptyOwner, paths.bin]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	const entries = readdirSync(paths.emptyOwner);
	if (entries.length > 0) {
		throw new Error(`${paths.emptyOwner} must stay empty but holds: ${entries.join(", ")}. Remove it and retry.`);
	}
}
