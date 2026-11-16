import { RuleDirection } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { type ObservedAgent, type PlanInput, computePlan, groupName } from "../../src/policy/plan.js";
import type { ObservedGroup } from "../../src/policy/stale-groups.js";
import { describeStep } from "../../src/identity/step-labels.js";
import { parsePolicy } from "../../src/policy/schema.js";
import { HERDR_DEFAULT_TOOLS } from "../../src/tool-profiles.js";
import { type Binding, BindingState, type PlanStep, PlanStepKind } from "../../src/types.js";

const ROOT = "/work/proj";
const ORG = "7c1e0a52-3b0f-4d6e-9a41-0f2d5c7b8e13";

function binding(name: string, n: number, state: BindingState = BindingState.PendingApply): Binding {
	return {
		key: n.toString(16).padStart(16, "0"),
		repoRoot: ROOT,
		herdrName: name,
		agentId: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
		handle: `${name}@x.rine.network`,
		configDir: `/s/${name}`,
		state,
		tools: state === BindingState.Applied ? [...HERDR_DEFAULT_TOOLS] : [],
		createdAt: "2026-11-13T00:00:00.000Z",
		appliedAt: null,
	};
}

const lead = binding("lead", 1);
const rev = binding("reviewer", 2);

function input(over: Partial<PlanInput> & { toml?: string } = {}): PlanInput {
	const { toml = "", ...rest } = over;
	return {
		policy: parsePolicy(toml),
		repoRoot: ROOT,
		bindings: [lead, rev],
		observed: {},
		groups: [],
		pendingExternalInvites: [],
		enforced: [],
		quota: { quotas: { max_groups: { limit: 5, used: 0 } } },
		...rest,
	};
}

const kinds = (steps: readonly { kind: string }[]) => steps.map((s) => s.kind);
const count = (steps: readonly { kind: string }[], kind: string) => steps.filter((s) => s.kind === kind).length;

describe("computePlan", () => {
	it("plans create, join, policy and mark for a fresh solo repo, in order", () => {
		const plan = computePlan(input());
		expect(plan.refusal).toBeNull();
		expect(plan.groupsNeeded).toBe(1);
		expect(count(plan.steps, PlanStepKind.CreateGroup)).toBe(1);
		expect(count(plan.steps, PlanStepKind.JoinGroup)).toBe(1);
		expect(count(plan.steps, PlanStepKind.SetAgentPolicy)).toBe(2);
		expect(count(plan.steps, PlanStepKind.MarkApplied)).toBe(2);
		const order = kinds(plan.steps);
		expect(order.indexOf(PlanStepKind.JoinGroup)).toBeLessThan(order.indexOf(PlanStepKind.SetAgentPolicy));
		expect(order.at(-1)).toBe(PlanStepKind.MarkApplied);
	});

	it("names the group from the repo and the sorted member ids", () => {
		const name = groupName(ROOT, [rev.agentId, lead.agentId]);
		expect(name).toMatch(/^herdr-[0-9a-f]{12}$/);
		expect(name).toBe(groupName(ROOT, [lead.agentId, rev.agentId]));
		expect(computePlan(input()).steps[0]).toMatchObject({ kind: PlanStepKind.CreateGroup, name, creatorKey: lead.key });
	});

	it("plans nothing once the observations match", () => {
		const name = groupName(ROOT, [lead.agentId, rev.agentId]);
		const seen: ObservedAgent = { incoming: "groups_only", outgoing: "groups_only", exposure: "private", allowedOrgIds: [] };
		const groups: ObservedGroup[] = [{ id: "g1", name, memberIds: [lead.agentId, rev.agentId], roster: null }];
		const applied = [binding("lead", 1, BindingState.Applied), binding("reviewer", 2, BindingState.Applied)];
		const plan = computePlan(input({ bindings: applied, groups, observed: { [lead.key]: seen, [rev.key]: seen } }));
		expect(plan.steps).toEqual([]);
		expect(plan.groupsNeeded).toBe(0);
	});

	it("joins a member missing from an existing group instead of creating one", () => {
		const name = groupName(ROOT, [lead.agentId, rev.agentId]);
		const plan = computePlan(input({ groups: [{ id: "g1", name, memberIds: [lead.agentId], roster: null }] }));
		expect(count(plan.steps, PlanStepKind.CreateGroup)).toBe(0);
		expect(plan.steps.filter((s) => s.kind === PlanStepKind.JoinGroup)).toEqual([
			{ kind: PlanStepKind.JoinGroup, groupName: name, memberKey: rev.key },
		]);
	});

	it("re-marks an applied binding whose tools differ from the policy's, naming what moved", () => {
		const applied = binding("lead", 1, BindingState.Applied);
		const toml = 'profile = "solo"\n[features]\ntools = ["rine_inspect"]';
		const plan = computePlan(input({ toml, bindings: [applied] }));
		const marks = plan.steps.filter((s) => s.kind === PlanStepKind.MarkApplied);
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({ memberKey: applied.key, previous: applied.tools });
		expect(describeStep(marks[0] as PlanStep, () => "planner")).toBe(`planner: rine tools ${applied.tools.length} -> ${applied.tools.length + 1} (+rine_inspect)`);
	});

	it("plans nothing for an applied binding whose tools already match", () => {
		const applied = binding("lead", 1, BindingState.Applied);
		expect(count(computePlan(input({ bindings: [applied] })).steps, PlanStepKind.MarkApplied)).toBe(0);
	});

	it("accepts external invites only for the named, invited agents", () => {
		const toml = `profile = "team"\n[[external.groups]]\nhandle = "#dev@b.rine.network"\nagents = ["lead"]`;
		const pendingExternalInvites = [
			{ groupHandle: "#dev@b.rine.network", memberKey: lead.key },
			{ groupHandle: "#dev@b.rine.network", memberKey: rev.key },
		];
		const plan = computePlan(input({ toml, pendingExternalInvites }));
		expect(plan.steps.filter((s) => s.kind === PlanStepKind.AcceptExternalInvite)).toEqual([
			{ kind: PlanStepKind.AcceptExternalInvite, groupHandle: "#dev@b.rine.network", memberKey: lead.key },
		]);
	});

	it("refuses with the numbers when the group quota is exhausted", () => {
		const plan = computePlan(input({ quota: { quotas: { max_groups: { limit: 5, used: 5 } } } }));
		expect(plan.steps).toEqual([]);
		expect(plan.groupsNeeded).toBe(1);
		expect(plan.groupsRemaining).toBe(0);
		expect(plan.refusal).toMatch(/raise the org's tier/);
		expect(plan.refusal).toMatch(/needs 1 new group but the org has used 5 of 5 allowed; delete groups you no longer use \(rine group list/);
	});

	it("treats a missing or null group limit as unlimited", () => {
		expect(computePlan(input({ quota: { quotas: {} } })).groupsRemaining).toBeNull();
		expect(computePlan(input({ quota: null })).groupsRemaining).toBeNull();
		expect(computePlan(input({ quota: null })).refusal).toBeNull();
		expect(computePlan(input({ quota: { quotas: { max_groups: { limit: null } } } })).refusal).toBeNull();
	});

	it("puts allow entries only when an org rule enforces and the profile is not solo", () => {
		const toml = `profile = "team"\n[external]\norgs = ["${ORG}"]`;
		expect(count(computePlan(input({ toml })).steps, PlanStepKind.PutAllow)).toBe(0);
		const enforcing = [RuleDirection.Inbound];
		expect(count(computePlan(input({ toml, enforced: enforcing })).steps, PlanStepKind.PutAllow)).toBe(2);
		const solo = `[external]\norgs = ["${ORG}"]`;
		expect(count(computePlan(input({ toml: solo, enforced: enforcing })).steps, PlanStepKind.PutAllow)).toBe(0);
	});

	it("sets open agents accept_all, send_all and findable", () => {
		const plan = computePlan(input({ toml: 'profile = "open"' }));
		expect(plan.steps).toContainEqual({ kind: PlanStepKind.SetAgentPolicy, memberKey: lead.key, incoming: "accept_all", outgoing: "send_all" });
		expect(plan.steps).toContainEqual({ kind: PlanStepKind.SetExposure, memberKey: lead.key, exposure: "findable" });
	});

	it("ignores unbound bindings", () => {
		const plan = computePlan(input({ bindings: [lead, binding("reviewer", 2, BindingState.Unbound)] }));
		expect(plan.groupsNeeded).toBe(0);
		expect(count(plan.steps, PlanStepKind.MarkApplied)).toBe(1);
	});
});
