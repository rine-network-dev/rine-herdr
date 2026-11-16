// step-labels.ts — one human line per plan step, naming bindings by their herdr name. The server's own word for
// a setting follows in parentheses, so the line can be matched to the API and to rine-herdr.toml.
import { type DesiredAgentPolicy, type PlanStep, PlanStepKind } from "../types.js";

const INCOMING = { groups_only: "receives only from its groups", accept_all: "receives from anyone" } as const;
const OUTGOING = { groups_only: "sends only to its groups", send_all: "sends to anyone" } as const;
const EXPOSURE = { private: "hidden from the directory", findable: "listed in the directory" } as const;

function policyLabel(incoming: DesiredAgentPolicy["incoming"], outgoing: DesiredAgentPolicy["outgoing"]): string {
	if (incoming === "groups_only" && outgoing === "groups_only") return "talks only to its groups (groups_only)";
	if (incoming === "accept_all" && outgoing === "send_all") return "talks to anyone, subject to first contact (accept_all, send_all)";
	return `${INCOMING[incoming]}, ${OUTGOING[outgoing]} (incoming ${incoming}, outgoing ${outgoing})`;
}

function toolsLabel(tools: readonly string[], previous: readonly string[]): string {
	if (previous.length === 0) return `turn on rine tools (${tools.length})`;
	const added = tools.filter((t) => !previous.includes(t)).map((t) => `+${t}`);
	const removed = previous.filter((t) => !tools.includes(t)).map((t) => `-${t}`);
	return `rine tools ${previous.length} -> ${tools.length} (${[...added, ...removed].join(", ")})`;
}

export function describeStep(step: PlanStep, nameOf: (key: string) => string): string {
	switch (step.kind) {
		case PlanStepKind.CreateGroup:
			return `create group ${step.name} (${nameOf(step.creatorKey)}, inviting ${step.inviteeKeys.map(nameOf).join(", ") || "nobody"})`;
		case PlanStepKind.JoinGroup:
			return `${nameOf(step.memberKey)} joins group ${step.groupName}`;
		case PlanStepKind.DissolveGroup:
			return `${nameOf(step.memberKey)} dissolves stale group ${step.groupName}`;
		case PlanStepKind.LeaveGroup:
			return `${nameOf(step.memberKey)} leaves stale group ${step.groupName} (others still use it)`;
		case PlanStepKind.AcceptExternalInvite:
			return `${nameOf(step.memberKey)} accepts the invite to ${step.groupHandle}`;
		case PlanStepKind.SetAgentPolicy:
			return `${nameOf(step.memberKey)}: ${policyLabel(step.incoming, step.outgoing)}`;
		case PlanStepKind.SetExposure:
			return `${nameOf(step.memberKey)}: ${EXPOSURE[step.exposure]} (${step.exposure})`;
		case PlanStepKind.PutAllow:
			return `${nameOf(step.memberKey)}: allow org ${step.counterpartyOrgId}`;
		case PlanStepKind.MarkApplied:
			return `${nameOf(step.memberKey)}: ${toolsLabel(step.tools, step.previous)}`;
	}
}
