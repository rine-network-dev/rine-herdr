// registry.ts — which repo and herdr name a live pane has, which is what a binding key is made of.
// The repo is the workspace's worktree root when herdr knows one, else the nearest directory above the
// pane's cwd that holds `.git`, so an agent that cd's inside its repo keeps its binding.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentInfo, agentGet, workspaceGet } from "../herdr/cli.js";
import type { HerdrPort } from "../herdr/port.js";
import type { PaneRef } from "../identity/bindings.js";
import { bindingKey } from "../identity/paths.js";

export function findRepoRoot(cwd: string | null): string | null {
	let dir = cwd;
	while (dir !== null) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		dir = parent === dir ? null : parent;
	}
	return null;
}

async function repoRootOf(port: HerdrPort, agent: AgentInfo): Promise<string | null> {
	const workspace = await workspaceGet(port, agent.workspaceId).catch(() => null);
	return workspace?.repoRoot ?? findRepoRoot(agent.cwd);
}

/** The pane's ref, or null when the pane has no named agent or sits in no repo. */
export async function refOf(port: HerdrPort, agent: AgentInfo): Promise<PaneRef | null> {
	if (agent.name === null) return null;
	const repoRoot = await repoRootOf(port, agent);
	return repoRoot === null ? null : { repoRoot, herdrName: agent.name };
}

/** The agent herdr sees in a pane; null when the pane runs none. */
export async function agentOfPane(port: HerdrPort, paneId: string): Promise<AgentInfo | null> {
	return agentGet(port, paneId).catch(() => null);
}

/** The binding key of the agent in a pane, or null when it has no ref. */
export async function keyOf(port: HerdrPort, agent: AgentInfo): Promise<string | null> {
	const ref = await refOf(port, agent);
	return ref === null ? null : bindingKey(ref.repoRoot, ref.herdrName);
}
