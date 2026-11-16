import { describe, expect, it } from "vitest";
import { describeStep } from "../../src/identity/step-labels.js";
import { computePlan, groupName, isStaleGroup, wantedGroupNames } from "../../src/policy/plan.js";
import { type ObservedGroup, staleGroupSteps } from "../../src/policy/stale-groups.js";
import { type Binding, BindingState, PlanStepKind } from "../../src/types.js";
import { parsePolicy } from "../../src/policy/schema.js";

const ROOT = "/work/proj";
const OUTSIDER = "00000000-0000-4000-8000-0000000000ff";

function binding(name: string, n: number): Binding {
	return {
		key: n.toString(16).padStart(16, "0"),
		repoRoot: ROOT,
		herdrName: name,
		agentId: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
		handle: `${name}@x.rine.network`,
		configDir: `/s/${name}`,
		state: BindingState.Applied,
		tools: [],
		createdAt: "2026-11-13T00:00:00.000Z",
		appliedAt: null,
	};
}

const lead = binding("lead", 1);
const dev = binding("dev", 2);
const live = [lead, dev];

/** A stale group both bound agents sit in, plus whatever `extra` roster rows say. */
function group(roster: ObservedGroup["roster"], over: Partial<ObservedGroup> = {}): ObservedGroup {
	return { id: "old", name: "herdr-aaaaaaaaaaaa", memberIds: [lead.agentId, dev.agentId], roster, ...over };
}
const row = (b: { agentId: string }, admin: boolean) => ({ agentId: b.agentId, admin });

describe("staleGroupSteps", () => {
	it("dissolves a group of only this repo's agents by the bound agent that administers it, not the lowest id", () => {
		const out = staleGroupSteps([group([row(lead, false), row(dev, true)])], live);
		expect(out.steps).toEqual([{ kind: PlanStepKind.DissolveGroup, groupId: "old", groupName: "herdr-aaaaaaaaaaaa", memberKey: dev.key }]);
		expect(out.dissolved).toBe(1);
		expect(out.stuck).toEqual([]);
	});

	it("never deletes a group someone outside the repo sits in: a non-admin bound agent leaves it", () => {
		const out = staleGroupSteps([group([row(lead, true), row(dev, false), { agentId: OUTSIDER, admin: false }])], live);
		expect(out.steps).toEqual([{ kind: PlanStepKind.LeaveGroup, groupId: "old", groupName: "herdr-aaaaaaaaaaaa", memberKey: dev.key }]);
		expect(out.dissolved).toBe(0);
		expect(describeStep(out.steps[0] as never, (k) => (k === dev.key ? "dev" : k))).toBe("dev leaves stale group herdr-aaaaaaaaaaaa (others still use it)");
	});

	it("plans a leave for every bound agent, so one apply converges and the plan after it is empty", () => {
		const third = binding("qa", 3);
		const bound = [lead, dev, third];
		const outsider = { agentId: OUTSIDER, admin: true };
		const first = staleGroupSteps([group([row(lead, false), row(dev, false), row(third, false), outsider], { memberIds: bound.map((b) => b.agentId) })], bound);
		expect(first.steps.map((s) => (s as { memberKey: string }).memberKey)).toEqual([lead.key, dev.key, third.key]);
		expect(first.steps.every((s) => s.kind === PlanStepKind.LeaveGroup)).toBe(true);
		const after = staleGroupSteps([group([outsider], { memberIds: [] })], bound);
		expect(after).toEqual({ steps: [], dissolved: 0, stuck: [] });
	});

	it("keeps one bound admin seated when no admin outside the repo stays, and says so", () => {
		const out = staleGroupSteps([group([row(lead, true), row(dev, true), { agentId: OUTSIDER, admin: false }])], live);
		expect(out.steps).toMatchObject([{ kind: PlanStepKind.LeaveGroup, memberKey: dev.key }]);
		expect(out.stuck).toHaveLength(1);
		const after = staleGroupSteps([group([row(lead, true), { agentId: OUTSIDER, admin: false }], { memberIds: [lead.agentId] })], live);
		expect(after.steps).toEqual([]);
	});

	it("lets a bound admin leave when the group has another admin", () => {
		const out = staleGroupSteps([group([row(lead, true), { agentId: OUTSIDER, admin: true }], { memberIds: [lead.agentId] })], live);
		expect(out.steps).toMatchObject([{ kind: PlanStepKind.LeaveGroup, memberKey: lead.key }]);
	});

	it("reports, and plans nothing for, a group whose only bound member is its last admin among outsiders", () => {
		const out = staleGroupSteps([group([row(lead, true), { agentId: OUTSIDER, admin: false }], { memberIds: [lead.agentId] })], live);
		expect(out.steps).toEqual([]);
		expect(out.stuck).toHaveLength(1);
		expect(out.stuck[0]).toMatch(/herdr-aaaaaaaaaaaa: .*neither deleted nor left/);
	});

	it("reports a group whose roster could not be read in full instead of acting on a guess", () => {
		const out = staleGroupSteps([group(null)], live);
		expect(out.steps).toEqual([]);
		expect(out.stuck[0]).toMatch(/member list could not be read/);
	});

	it("skips a group none of this repo's live agents sit in", () => {
		const out = staleGroupSteps([group([{ agentId: OUTSIDER, admin: true }], { memberIds: [] })], live);
		expect(out).toEqual({ steps: [], dissolved: 0, stuck: [] });
	});
});

describe("which groups are stale", () => {
	it("names a group stale only when it is herdr-made and no clique of the policy asks for it", () => {
		const policy = parsePolicy("");
		const wanted = wantedGroupNames({ policy, repoRoot: ROOT, bindings: live });
		expect(wanted).toEqual(new Set([groupName(ROOT, [lead.agentId, dev.agentId])]));
		expect(isStaleGroup(groupName(ROOT, [lead.agentId, dev.agentId]), wanted)).toBe(false);
		expect(isStaleGroup(groupName(ROOT, [lead.agentId]), wanted)).toBe(true);
		expect(isStaleGroup("herdr-mine", wanted)).toBe(false);
	});
});

describe("computePlan with stale groups", () => {
	const input = (over: Record<string, unknown> = {}) => ({
		policy: parsePolicy(""),
		repoRoot: ROOT,
		bindings: live,
		observed: {},
		groups: [] as ObservedGroup[],
		pendingExternalInvites: [],
		enforced: [],
		quota: { quotas: { max_groups: { limit: 1, used: 1 } } },
		...over,
	});
	const staleDissolvable = group([row(lead, true), row(dev, false)]);

	it("counts the groups it deletes as room for the new one, and deletes first", () => {
		const plan = computePlan(input({ groups: [staleDissolvable] }));
		expect(plan.refusal).toBeNull();
		expect(plan.steps.map((s) => s.kind).slice(0, 2)).toEqual([PlanStepKind.DissolveGroup, PlanStepKind.CreateGroup]);
	});

	it("does not count a group it only leaves, and says how many deletions it counted", () => {
		const plan = computePlan(input({ groups: [group([row(lead, true), row(dev, false), { agentId: OUTSIDER, admin: false }])] }));
		expect(plan.refusal).toMatch(/needs 1 new group but the org has used 1 of 1 allowed; delete/);
		const refused = computePlan(input({ groups: [staleDissolvable, group([row(lead, true), row(dev, false)], { id: "old2", name: "herdr-bbbbbbbbbbbb" })], quota: { quotas: { max_groups: { limit: 2, used: 2 } } } }));
		expect(refused.refusal).toBeNull();
	});

	it("carries the stuck lines on the plan and ignores groups that are not herdr-made names", () => {
		const stuck = group(null);
		const mine = computePlan(input({ groups: [stuck, group([row(lead, true)], { id: "x", name: "herdr-mine" })], quota: null }));
		expect(mine.stuck).toHaveLength(1);
		expect(mine.steps.some((s) => s.kind === PlanStepKind.DissolveGroup || s.kind === PlanStepKind.LeaveGroup)).toBe(false);
	});
});
