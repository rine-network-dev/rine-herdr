// plan.ts — the pure diff between the policy file and what the server shows. Lane-C code gathers the
// observations; nothing here does I/O, so re-planning against updated observations is the idempotence proof.
import { createHash } from "node:crypto";
import type { RuleDirection } from "@rine-network/core";
import {
	type Binding,
	BindingState,
	type DesiredAgentPolicy,
	type Plan,
	type PlanStep,
	PlanStepKind,
	Profile,
} from "../types.js";
import { cliques } from "./graph.js";
import { profileSettings } from "./profiles.js";
import type { PolicyFile } from "./schema.js";
import { type ObservedGroup, staleGroupSteps } from "./stale-groups.js";

export const GROUP_PREFIX = "herdr-";
export const GROUP_QUOTA_KEY = "max_groups";

export interface ObservedAgent {
	incoming: DesiredAgentPolicy["incoming"];
	outgoing: DesiredAgentPolicy["outgoing"];
	exposure: DesiredAgentPolicy["exposure"];
	/** Counterparty org ids this agent already has an allow entry for. */
	allowedOrgIds: readonly string[];
}

export interface PlanInput {
	policy: PolicyFile;
	repoRoot: string;
	bindings: readonly Binding[];
	/** Per binding key; a missing entry reads as not yet applied. */
	observed: Readonly<Record<string, ObservedAgent>>;
	/** The herdr-* groups our repo's agents sit in. */
	groups: readonly ObservedGroup[];
	pendingExternalInvites: readonly { groupHandle: string; memberKey: string }[];
	/** Directions whose external message rule the org enforces; allow entries matter only for these. */
	enforced: readonly RuleDirection[];
	/** Null when no owner key was loaded: the branch cannot read quotas, and the server refuses a group over quota. */
	quota: { quotas: Readonly<Record<string, { limit: number | null; used?: number | null }>> } | null;
}

export function groupName(repoRoot: string, memberAgentIds: readonly string[]): string {
	const digest = createHash("sha256").update(`${repoRoot}\n${[...memberAgentIds].sort().join("\n")}`).digest("hex");
	return GROUP_PREFIX + digest.slice(0, 12);
}

interface Clique {
	name: string;
	members: Binding[]; // sorted by agent id; the first creates the group
}

type CliqueInput = Pick<PlanInput, "policy" | "repoRoot">;

function desiredCliques(input: CliqueInput, live: readonly Binding[]): Clique[] {
	const byName = new Map(live.map((b) => [b.herdrName, b]));
	return cliques(input.policy.graph, [...byName.keys()]).map((names) => {
		const members = names.map((n) => byName.get(n) as Binding).sort((a, b) => a.agentId.localeCompare(b.agentId));
		return { name: groupName(input.repoRoot, members.map((m) => m.agentId)), members };
	});
}

function groupSteps(input: PlanInput, wanted: readonly Clique[]): { steps: PlanStep[]; created: number } {
	const steps: PlanStep[] = [];
	let created = 0;
	for (const { name, members } of wanted) {
		const existing = input.groups.find((g) => g.name === name);
		if (!existing) {
			created++;
			const [creator, ...invitees] = members as [Binding, ...Binding[]];
			steps.push({ kind: PlanStepKind.CreateGroup, name, creatorKey: creator.key, inviteeKeys: invitees.map((m) => m.key) });
			for (const m of invitees) steps.push({ kind: PlanStepKind.JoinGroup, groupName: name, memberKey: m.key });
			continue;
		}
		for (const m of members.filter((b) => !existing.memberIds.includes(b.agentId))) {
			steps.push({ kind: PlanStepKind.JoinGroup, groupName: name, memberKey: m.key });
		}
	}
	return { steps, created };
}

const HERDR_GROUP_NAME = new RegExp(`^${GROUP_PREFIX}[0-9a-f]{12}$`);

const liveBindings = (bindings: readonly Binding[]): Binding[] => bindings.filter((b) => b.state !== BindingState.Unbound);

/** The names of the groups the policy asks for, so a caller can tell which observed groups are stale before reading them. */
export function wantedGroupNames(input: CliqueInput & { bindings: readonly Binding[] }): Set<string> {
	return new Set(desiredCliques(input, liveBindings(input.bindings)).map((c) => c.name));
}

/** A herdr-* group no clique of the policy names. groupName() made them; no other group matches. */
export const isStaleGroup = (name: string, wanted: ReadonlySet<string>): boolean => HERDR_GROUP_NAME.test(name) && !wanted.has(name);

const sameTools = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t) => b.includes(t));

/** Pending bindings get their tools turned on; an applied one is re-marked when the policy's tool list moved. */
function toolSteps(input: PlanInput, live: readonly Binding[]): PlanStep[] {
	const { tools } = profileSettings(input.policy.profile, input.policy.featureTools);
	return live.flatMap((b): PlanStep[] =>
		b.state === BindingState.Applied && sameTools(b.tools, tools)
			? []
			: [{ kind: PlanStepKind.MarkApplied, memberKey: b.key, tools, previous: b.tools }],
	);
}

function externalSteps(input: PlanInput, live: readonly Binding[]): PlanStep[] {
	if (input.policy.profile === Profile.Solo) return [];
	const keyOf = new Map(live.map((b) => [b.herdrName, b.key]));
	return input.policy.externalGroups.flatMap((g) =>
		g.agents.flatMap((agent) => {
			const memberKey = keyOf.get(agent);
			const invited = input.pendingExternalInvites.some((i) => i.groupHandle === g.handle && i.memberKey === memberKey);
			return memberKey && invited
				? [{ kind: PlanStepKind.AcceptExternalInvite, groupHandle: g.handle, memberKey } as PlanStep]
				: [];
		}),
	);
}

function agentSteps(input: PlanInput, live: readonly Binding[]): PlanStep[][] {
	const want = profileSettings(input.policy.profile, input.policy.featureTools);
	const enforcing = input.enforced.length > 0;
	const orgs = input.policy.profile === Profile.Solo || !enforcing ? [] : input.policy.externalOrgs;
	const policy: PlanStep[] = [];
	const exposure: PlanStep[] = [];
	const allow: PlanStep[] = [];
	for (const b of live) {
		const seen = input.observed[b.key];
		if (!seen || seen.incoming !== want.incoming || seen.outgoing !== want.outgoing) {
			policy.push({ kind: PlanStepKind.SetAgentPolicy, memberKey: b.key, incoming: want.incoming, outgoing: want.outgoing });
		}
		if (!seen || seen.exposure !== want.exposure) {
			exposure.push({ kind: PlanStepKind.SetExposure, memberKey: b.key, exposure: want.exposure });
		}
		for (const counterpartyOrgId of orgs.filter((o) => !seen?.allowedOrgIds.includes(o))) {
			allow.push({ kind: PlanStepKind.PutAllow, memberKey: b.key, counterpartyOrgId });
		}
	}
	return [policy, exposure, allow];
}

export function computePlan(input: PlanInput): Plan {
	const live = liveBindings(input.bindings);
	const wanted = desiredCliques(input, live);
	const wantedNames = new Set(wanted.map((c) => c.name));
	const { steps: groups, created } = groupSteps(input, wanted);
	const { steps: stale, dissolved, stuck } = staleGroupSteps(input.groups.filter((g) => isStaleGroup(g.name, wantedNames)), live);
	const quota = input.quota?.quotas[GROUP_QUOTA_KEY];
	const groupsRemaining = quota?.limit == null ? null : Math.max(0, quota.limit - (quota.used ?? 0));
	const base = { repoRoot: input.repoRoot, groupsNeeded: created, groupsRemaining, stuck };
	if (groupsRemaining !== null && created > groupsRemaining + dissolved) {
		const freed = dissolved > 0 ? ` even after deleting ${dissolved} stale ${dissolved === 1 ? "group" : "groups"}` : "";
		return {
			...base,
			steps: [],
			refusal: `needs ${created} new ${created === 1 ? "group" : "groups"} but the org has used ${quota?.used ?? 0} of ${quota?.limit} allowed${freed}; delete groups you no longer use (rine group list, rine group delete), raise the org's tier, or trim local.graph`,
		};
	}
	// Stale groups go first: deleting one makes room, and the server counts a new group against the quota as it is created.
	const steps = [
		...stale,
		...groups,
		...externalSteps(input, live),
		...agentSteps(input, live).flat(),
		...toolSteps(input, live),
	];
	return { ...base, steps, refusal: null };
}
