// observe.ts — read what the server shows for one repo's agents and shape it for `computePlan`.
// Every agent is read with its own client; the org-wide reads use the host branch, and the owner only where the plan
// needs allow entries or a loosening the branch may not make.
import { RuleDirection, fetchAllAllow, getExposure } from "@rine-network/core";
import { type AsyncRineClient, asGroupUuid } from "@rine-network/sdk";
import { GROUP_PREFIX, type ObservedAgent, type PlanInput, isStaleGroup, wantedGroupNames } from "../policy/plan.js";
import type { ObservedGroup } from "../policy/stale-groups.js";
import { profileSettings } from "../policy/profiles.js";
import { loadPolicy } from "../policy/schema.js";
import { type Binding, BindingState, type DesiredAgentPolicy, type Host } from "../types.js";
import { authorityLine, enforcedDirections, ownerNeed, readRuleModes } from "./authority.js";
import { type AuthorityClients, agentClient, branchClients, ownerClients } from "./clients.js";
import { repoSlug } from "./names.js";
import type { StatePaths } from "./paths.js";
import { type UnseatedTracker, unseatedTracker } from "./unseated.js";

/** How apply reaches the daemon-owned bindings; the entrypoint supplies the daemon-backed one. */
export interface BindingsPort {
	snapshot(repoRoot: string): Promise<readonly Binding[]>;
	markApplied(keys: readonly string[], tools: Readonly<Record<string, readonly string[]>>): Promise<void>;
}

export interface ApplyEnv {
	paths: StatePaths;
	host: Host;
	ownerDir: string;
	ipc: BindingsPort;
	log: (line: string) => void;
}

/** Everything `executePlan` acts with. */
export interface ApplyClients {
	/** Acts for policy and exposure steps: the branch, or the owner once the branch is refused. */
	authority: AuthorityClients;
	/** Writes allow entries; null unless the plan needs them. */
	owner: AuthorityClients | null;
	/** Loads the owner on demand, for a server that refuses the branch; throws when no owner root is on this host. */
	loadOwner: () => AuthorityClients;
	/** Pane agents' own clients, by binding key. */
	agents: ReadonlyMap<string, AsyncRineClient>;
	bindings: ReadonlyMap<string, Binding>;
	/** `herdr-*` group name to id: seeded from what the agents see, extended as groups are created. */
	groupIds: Map<string, string>;
	/** Directions whose rule is at `enforce`, so allow entries are written for them. */
	enforced: readonly RuleDirection[];
	/** Invitees an MLS admission left without a leaf, reported once the plan has run. */
	unseated: UnseatedTracker;
	repoSlug: string;
	ipc: BindingsPort;
	log: (line: string) => void;
}

export interface Observation {
	input: PlanInput;
	/** The one line naming who acts, for `plan` and `apply` to print. */
	authorityLine: string;
	clients: ApplyClients;
}

/** A custom exposure is neither profile value, so it reads as the one that differs from `want`. */
function exposureSeen(preset: string, want: DesiredAgentPolicy["exposure"]): DesiredAgentPolicy["exposure"] {
	if (preset === "private" || preset === "findable") return preset;
	return want === "private" ? "findable" : "private";
}

type AgentRow = Awaited<ReturnType<AsyncRineClient["listAgents"]>>[number];
const incomingOf = (row: AgentRow): ObservedAgent["incoming"] => (row.incoming_policy === "groups_only" ? "groups_only" : "accept_all");
const outgoingOf = (row: AgentRow): ObservedAgent["outgoing"] => (row.outgoing_policy === "groups_only" ? "groups_only" : "send_all");

/** Who sits in a stale group and who administers it; null when a page is missing or the read fails (logged), so the plan never guesses. */
async function readRoster(client: AsyncRineClient | undefined, group: ObservedGroup, log: ApplyEnv["log"]): Promise<ObservedGroup["roster"]> {
	try {
		const page = await client?.groups.members(asGroupUuid(group.id));
		return page === undefined || page.hasNext ? null : page.items.map((m) => ({ agentId: m.agent_id, admin: m.role === "admin" }));
	} catch (err) {
		log(`warning: could not read the members of ${group.name}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

export async function observe(env: ApplyEnv, repoRoot: string): Promise<Observation> {
	const { host, paths } = env;
	const policy = loadPolicy(repoRoot);
	const want = profileSettings(policy.profile, policy.featureTools);
	const bindings = await env.ipc.snapshot(repoRoot);
	const live = bindings.filter((b) => b.state !== BindingState.Unbound);
	const branch = branchClients(paths, host.apiUrl);
	const unseated = unseatedTracker();
	const pairs = live.map((b) => ({ b, client: agentClient(b.configDir, host.apiUrl, unseated) }));
	const [modes, orgAgents] = await Promise.all([readRuleModes(branch.http), branch.sdk.listAgents()]);
	const enforced = enforcedDirections(modes);
	const rows = new Map(live.flatMap((b) => orgAgents.filter((a) => a.id === b.agentId).map((a) => [b.key, a] as const)));
	const need = ownerNeed(
		policy.profile,
		policy.externalOrgs,
		modes,
		want,
		[...rows.values()].map((a) => ({ incoming: incomingOf(a), outgoing: outgoingOf(a) })),
	);
	const loadOwner = (): AuthorityClients =>
		ownerClients({ configDir: paths.branchHome, ownerDir: env.ownerDir, apiUrl: host.apiUrl, orgId: host.orgId });
	const owner = need.allow || need.loosening ? loadOwner() : null;
	const quota = owner ? await owner.sdk.getQuotas() : null;
	const allow = owner && need.allow ? await fetchAllAllow(owner.http) : [];

	const seen = await Promise.all(
		pairs.map(async ({ b, client }) => ({
			b,
			client,
			groups: (await client.groups.list()).items,
			invites: await client.groups.listInvites(),
		})),
	);

	const groups = new Map<string, ObservedGroup & { memberIds: string[] }>();
	const askers = new Map<string, AsyncRineClient>();
	for (const { b, client, groups: rows } of seen) {
		for (const g of rows.filter((r) => r.name.startsWith(GROUP_PREFIX))) {
			const known = groups.get(g.id) ?? { id: g.id, name: g.name, memberIds: [], roster: null };
			known.memberIds.push(b.agentId);
			groups.set(g.id, known);
			askers.set(g.id, askers.get(g.id) ?? client);
		}
	}
	const wantedNames = wantedGroupNames({ policy, repoRoot, bindings });
	const stale = [...groups.values()].filter((g) => isStaleGroup(g.name, wantedNames));
	await Promise.all(stale.map(async (g) => void (g.roster = await readRoster(askers.get(g.id), g, env.log))));

	// The list rows carry no preset, so each agent's exposure is read from its own endpoint.
	const presets = new Map(await Promise.all(live.map(async (b) => [b.key, (await getExposure(branch.http, b.agentId)).preset] as const)));
	const observed: Record<string, ObservedAgent> = {};
	for (const b of live) {
		const row = rows.get(b.key);
		const preset = presets.get(b.key);
		if (!row || preset === undefined) continue;
		const orgsAllowed = enforced.map(
			(direction) =>
				new Set(allow.filter((e) => e.scope_agent_id === b.agentId && e.direction === direction).map((e) => e.counterparty_org_id)),
		);
		observed[b.key] = {
			incoming: incomingOf(row),
			outgoing: outgoingOf(row),
			exposure: exposureSeen(preset, want.exposure),
			allowedOrgIds: [...(orgsAllowed[0] ?? [])].filter((id) => orgsAllowed.every((s) => s.has(id))),
		};
	}

	return {
		input: {
			policy,
			repoRoot,
			bindings,
			observed,
			groups: [...groups.values()],
			pendingExternalInvites: seen.flatMap(({ b, invites }) =>
				invites.flatMap((i) => (i.status === "invited" && i.group_handle ? [{ groupHandle: i.group_handle, memberKey: b.key }] : [])),
			),
			enforced,
			quota,
		},
		authorityLine: authorityLine(host, need),
		clients: {
			authority: need.loosening && owner ? owner : branch,
			owner,
			loadOwner,
			agents: new Map(pairs.map(({ b, client }) => [b.key, client])),
			bindings: new Map(live.map((b) => [b.key, b])),
			groupIds: new Map([...groups.values()].map((g) => [g.name, g.id])),
			enforced,
			unseated,
			repoSlug: repoSlug(repoRoot),
			ipc: env.ipc,
			log: env.log,
		},
	};
}
