// provision.ts — mint one rine agent for one pane. The branch creates it; its keys land in the pane's own dir,
// so the branch home never holds an agent key and the pane never holds anything but its own.
import { mkdirSync } from "node:fs";
import {
	DEFAULT_PROFILE,
	Preset,
	RineApiError,
	getProfile,
	performAgentCreation,
} from "@rine-network/core";
import { type PolicyFile } from "../policy/schema.js";
import { type Binding, BindingState, type Host } from "../types.js";
import type { PaneRef } from "./bindings.js";
import { coreHttp } from "./clients.js";
import { rineAgentName, repoSlug } from "./names.js";
import { type StatePaths, agentDir, bindingKey } from "./paths.js";

const CONFLICT = 409;

/** The role the policy file gives this herdr name, else the name itself. */
function roleOf(policy: PolicyFile, herdrName: string): string {
	return policy.agents.find((a) => a.name === herdrName)?.role ?? herdrName;
}

export async function provisionBinding(
	paths: StatePaths,
	host: Host,
	pane: PaneRef,
	policy: PolicyFile,
	now: () => Date = () => new Date(),
): Promise<Binding> {
	const key = bindingKey(pane.repoRoot, pane.herdrName);
	const paneDir = agentDir(paths, key);
	mkdirSync(paneDir, { recursive: true, mode: 0o700 });
	if (getProfile(paneDir, DEFAULT_PROFILE)) throw new Error(`${paneDir} already holds an agent identity; unbind it first`);

	const dirs = { configDir: paths.branchHome, ownerDir: paths.emptyOwner };
	const client = coreHttp(dirs, host.apiUrl);
	const base = rineAgentName(repoSlug(pane.repoRoot), roleOf(policy, pane.herdrName));
	const create = (name: string) =>
		performAgentCreation(client, dirs, DEFAULT_PROFILE, { name, branch: host.branch, exposure: Preset.Private, into: paneDir });

	let agent: Awaited<ReturnType<typeof create>>;
	try {
		agent = await create(base);
	} catch (err) {
		if (!(err instanceof RineApiError) || err.status !== CONFLICT) throw err;
		try {
			agent = await create(`${base}-${host.hostSlug}`);
		} catch (retry) {
			if (retry instanceof RineApiError && retry.status === CONFLICT) {
				throw new Error(`agent names ${base} and ${base}-${host.hostSlug} are both taken; give this pane a role in [[agents]]`);
			}
			throw retry;
		}
	}
	if (!agent.handle) throw new Error(`the server created agent ${agent.id} without a handle`);
	return {
		key,
		repoRoot: pane.repoRoot,
		herdrName: pane.herdrName,
		agentId: agent.id,
		handle: agent.handle,
		configDir: paneDir,
		state: BindingState.PendingApply,
		tools: [],
		createdAt: now().toISOString(),
		appliedAt: null,
	};
}
