// stale-groups.ts — what to do with a herdr-* group the policy no longer wants. The server lets only a group admin
// delete a group, and refuses the last admin's leave, so the plan picks an actor that can do the thing it plans. A
// group that holds anyone outside this repo's agents is never deleted: our agents leave it instead.
import { type Binding, type PlanStep, PlanStepKind } from "../types.js";

export interface RosterEntry {
	agentId: string;
	admin: boolean;
}

export interface ObservedGroup {
	id: string;
	name: string;
	/** This repo's bound agents seated in the group. */
	memberIds: readonly string[];
	/** Everyone seated, with roles; read for stale groups only, and null when it was not or could not be read in full. */
	roster: readonly RosterEntry[] | null;
}

export interface StaleGroups {
	steps: PlanStep[];
	/** How many planned steps delete a group, which is what frees quota. */
	dissolved: number;
	/** One line per group nobody on this host can dissolve or leave. */
	stuck: string[];
}

const byAgentId = (a: Binding, b: Binding): number => a.agentId.localeCompare(b.agentId);

export function staleGroupSteps(stale: readonly ObservedGroup[], live: readonly Binding[]): StaleGroups {
	const out: StaleGroups = { steps: [], dissolved: 0, stuck: [] };
	const ours = new Set(live.map((b) => b.agentId));
	for (const g of stale) {
		const { roster } = g;
		const seatedIds = roster?.map((r) => r.agentId) ?? g.memberIds;
		const seated = live.filter((b) => seatedIds.includes(b.agentId)).sort(byAgentId);
		if (seated.length === 0) continue;
		if (roster === null) {
			out.stuck.push(`stale group ${g.name}: its member list could not be read, so it is left as it is; the next apply reads it again`);
			continue;
		}
		const base = { groupId: g.id, groupName: g.name };
		const admins = new Set(roster.filter((r) => r.admin).map((r) => r.agentId));
		const dissolver = roster.every((r) => ours.has(r.agentId)) ? seated.find((b) => admins.has(b.agentId)) : undefined;
		if (dissolver) {
			out.steps.push({ kind: PlanStepKind.DissolveGroup, ...base, memberKey: dissolver.key });
			out.dissolved++;
			continue;
		}
		// Every bound agent leaves, so one apply converges. The server refuses the last admin's leave, so when no admin
		// outside this repo stays, one bound admin stays seated and is reported.
		const outsideAdmin = roster.some((r) => r.admin && !ours.has(r.agentId));
		const stays = outsideAdmin ? undefined : seated.find((b) => admins.has(b.agentId));
		for (const b of seated) if (b !== stays) out.steps.push({ kind: PlanStepKind.LeaveGroup, ...base, memberKey: b.key });
		if (stays) out.stuck.push(`stale group ${g.name}: it holds agents outside this repo and ours is its only admin, so it can be neither deleted nor left; an admin must hand over or remove it`);
	}
	return out;
}
