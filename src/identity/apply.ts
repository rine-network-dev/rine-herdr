// apply.ts — carry a plan out. Group seats are each agent's own act; policy and exposure are the host branch's;
// allow entries are the owner's. The first failure stops execution and the rest of the steps come back unrun, except
// dissolving or leaving a stale group: that is housekeeping, so a refusal there is collected and the independent steps
// still run.
import { createdGroupMls, Decision, putAllow, putExposure } from "@rine-network/core";
import { asAgentUuid, asGroupUuid, RineApiError } from "@rine-network/sdk";
import { type Plan, type PlanStep, PlanStepKind } from "../types.js";
import type { ApplyClients } from "./observe.js";
import { describeStep } from "./step-labels.js";

export interface StepFailure {
	step: PlanStep;
	message: string;
}

export interface ApplyResult {
	executed: readonly PlanStep[];
	failure: StepFailure | null;
	/** Steps not run: the failed one first, then everything after it. */
	remaining: readonly PlanStep[];
	/** Stale groups that could be neither dissolved nor left; the plan carried on past them. */
	stale: readonly StepFailure[];
}

/** What a server that predates branch policy writes answers a branch key on `PATCH /agents/{id}`. */
const ROUTE_REFUSED = "principal not permitted on this route";
const NEW_AGENTS_STOPPED = "new_agents_stopped";
const OWNER_ADVICE = "set RINE_OWNER_DIR to the owner directory and run rine-herdr apply again";

/** The branch key was refused where the owner is admitted: an older server, or the org stopped new agents since planning. */
class BranchPolicyUnsupported extends Error {
	constructor(readonly stopped: boolean) {
		super(stopped ? NEW_AGENTS_STOPPED : ROUTE_REFUSED);
	}
}

type PolicyStep = Extract<PlanStep, { kind: typeof PlanStepKind.SetAgentPolicy }>;

async function setPolicy(c: ApplyClients, step: PolicyStep): Promise<void> {
	try {
		await c.authority.sdk.updateAgent(asAgentUuid(agentIdOf(c, step.memberKey)), { incoming_policy: step.incoming, outgoing_policy: step.outgoing });
	} catch (err) {
		if (c.authority.kind !== "branch" || !(err instanceof RineApiError) || err.status !== 403) throw err;
		if (err.code === NEW_AGENTS_STOPPED) throw new BranchPolicyUnsupported(true);
		if (err.detail === ROUTE_REFUSED) throw new BranchPolicyUnsupported(false);
		throw err;
	}
}

/** Carry on as the owner from here on; stops with the owner-dir advice when this host holds no org root. */
function switchToOwner(c: ApplyClients, why: BranchPolicyUnsupported): void {
	c.log(
		why.stopped
			? "the org stops new agents, so only the org loosens an agent's policy; continuing as the org owner"
			: "this rine server does not let a branch key set agent policy yet; continuing as the org owner",
	);
	try {
		c.authority = c.owner ?? c.loadOwner();
		c.owner = c.authority;
	} catch {
		throw new Error(
			why.stopped
				? `the org stops new agents, so the org owner must loosen this agent's policy; ${OWNER_ADVICE}`
				: `this rine server needs the org owner to set agent policy; ${OWNER_ADVICE}`,
		);
	}
}

function groupId(c: ApplyClients, name: string): string {
	const id = c.groupIds.get(name);
	if (!id) throw new Error(`group ${name} is not visible to any of this repo's agents; run plan again`);
	return id;
}

async function joinGroup(c: ApplyClients, memberKey: string, id: string): Promise<void> {
	const joined = await agentOf(c, memberKey).groups.join(asGroupUuid(id));
	if (joined.status !== "joined") throw new Error(`joining ${id} is pending approval instead of seating the agent`);
	c.unseated.seated(id, agentIdOf(c, memberKey));
}

function agentOf(c: ApplyClients, key: string) {
	const client = c.agents.get(key);
	if (!client) throw new Error(`no client for binding ${key}`);
	return client;
}

function agentIdOf(c: ApplyClients, key: string): string {
	const binding = c.bindings.get(key);
	if (!binding) throw new Error(`no binding ${key}`);
	return binding.agentId;
}

async function run(step: PlanStep, c: ApplyClients): Promise<void> {
	switch (step.kind) {
		case PlanStepKind.CreateGroup: {
			const creator = agentOf(c, step.creatorKey);
			const created = await creator.groups.create(step.name, {
				visibility: "private",
				enrollment: "closed",
				members: step.inviteeKeys.map((k) => asAgentUuid(agentIdOf(c, k))),
			});
			c.groupIds.set(step.name, created.id);
			// Graded from the create RESULT: the row alone cannot tell a founded group from an unfounded one.
			const mls = createdGroupMls(created);
			const reason = created.mlsInit ? `: ${created.mlsInit.reason}` : "";
			if (mls.mode !== "MLS") c.log(`warning: group ${step.name} exists but its post-quantum MLS state did not start${reason}. ${mls.note}`.trimEnd());
			return;
		}
		case PlanStepKind.JoinGroup:
			return joinGroup(c, step.memberKey, groupId(c, step.groupName));
		case PlanStepKind.DissolveGroup:
			await agentOf(c, step.memberKey).groups.delete(asGroupUuid(step.groupId));
			return;
		case PlanStepKind.LeaveGroup:
			await agentOf(c, step.memberKey).groups.leave(asGroupUuid(step.groupId), { agent: agentIdOf(c, step.memberKey) });
			return;
		case PlanStepKind.AcceptExternalInvite: {
			const invite = (await agentOf(c, step.memberKey).groups.listInvites()).find((i) => i.group_handle === step.groupHandle);
			if (!invite) throw new Error(`no invitation to ${step.groupHandle} for ${c.bindings.get(step.memberKey)?.herdrName}`);
			return joinGroup(c, step.memberKey, invite.group_id);
		}
		case PlanStepKind.SetAgentPolicy:
			return setPolicy(c, step);
		case PlanStepKind.SetExposure:
			await putExposure(c.authority.http, agentIdOf(c, step.memberKey), step.exposure);
			return;
		case PlanStepKind.PutAllow: {
			if (!c.owner) throw new Error(`allow entries need the org owner; ${OWNER_ADVICE}`);
			for (const direction of c.enforced) {
				await putAllow(c.owner.http, {
					direction,
					agent_id: agentIdOf(c, step.memberKey),
					counterparty_org_id: step.counterpartyOrgId,
					decision: Decision.Allow,
					reason: `rine-herdr apply ${c.repoSlug}`,
				});
			}
			return;
		}
		case PlanStepKind.MarkApplied:
			await c.ipc.markApplied([step.memberKey], { [step.memberKey]: step.tools });
			return;
	}
}

/** One line per group that still has an unseated agent once every step has run. */
function logUnseated(c: ApplyClients): void {
	const nameOfGroup = new Map([...c.groupIds].map(([name, id]) => [id, name]));
	const nameOfAgent = new Map([...c.bindings.values()].map((b) => [b.agentId, b.herdrName]));
	for (const [id, agents] of c.unseated.remaining()) {
		const who = [...agents].map((a) => nameOfAgent.get(a) ?? a).join(", ");
		c.log(`${nameOfGroup.get(id) ?? id}: ${who} not seated yet; it seats itself on its next sync`);
	}
}

/** One step; a branch refusal of a policy write continues as the owner, retrying this step and carrying the rest. */
async function runStep(step: PlanStep, c: ApplyClients): Promise<void> {
	try {
		await run(step, c);
	} catch (err) {
		if (!(err instanceof BranchPolicyUnsupported)) throw err;
		switchToOwner(c, err);
		await run(step, c);
	}
}

export async function executePlan(plan: Plan, c: ApplyClients): Promise<ApplyResult> {
	const nameOf = (key: string) => c.bindings.get(key)?.herdrName ?? key;
	const executed: PlanStep[] = [];
	const stale: StepFailure[] = [];
	for (const [i, step] of plan.steps.entries()) {
		try {
			await runStep(step, c);
		} catch (err) {
			const message = (err as Error).message;
			c.log(`FAILED ${describeStep(step, nameOf)}: ${message}`);
			if (step.kind === PlanStepKind.DissolveGroup || step.kind === PlanStepKind.LeaveGroup) {
				stale.push({ step, message });
				continue;
			}
			logUnseated(c);
			return { executed, failure: { step, message }, remaining: plan.steps.slice(i), stale };
		}
		c.log(`ok ${describeStep(step, nameOf)}`);
		executed.push(step);
	}
	logUnseated(c);
	return { executed, failure: null, remaining: [], stale };
}
