// types.ts — the shared vocabulary of rine-herdr. Every module imports from here;
// nothing here does I/O. Lanes may ADD types; they never change these without the orchestrator.
import { z } from "zod";

export const Profile = { Solo: "solo", Team: "team", Open: "open" } as const;
export type Profile = (typeof Profile)[keyof typeof Profile];

export const FirstContact = { Approve: "approve", Allow: "allow", Deny: "deny" } as const;
export type FirstContact = (typeof FirstContact)[keyof typeof FirstContact];

/** herdr's agent states (pane.agent_status_changed `agent_status`). */
export const AgentStatus = {
	Idle: "idle",
	Working: "working",
	Blocked: "blocked",
	Done: "done",
	Unknown: "unknown",
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const BindingState = { PendingApply: "pending_apply", Applied: "applied", Unbound: "unbound" } as const;
export type BindingState = (typeof BindingState)[keyof typeof BindingState];

export const SenderClass = {
	SameOrg: "same_org",
	Group: "group",
	ExternalAllowlisted: "external_allowlisted",
	ExternalApproved: "external_approved",
} as const;
export type SenderClass = (typeof SenderClass)[keyof typeof SenderClass];

export const HERDR_DEFAULT_TOOLS = [
	"rine_whoami",
	"rine_send",
	"rine_send_and_wait",
	"rine_reply",
	"rine_read",
	"rine_inbox",
	"rine_thread",
	"rine_groups",
] as const;

export const HERDR_OPTIONAL_TOOLS = ["rine_inspect", "rine_discover", "rine_group_roster", "rine_group_inspect"] as const;

export type OptionalTool = (typeof HERDR_OPTIONAL_TOOLS)[number];

export const herdrAgentName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const rineToolName = z.string().regex(/^rine_[a-z0-9_]+$/);
export const herdrTool = z.enum([...HERDR_DEFAULT_TOOLS, ...HERDR_OPTIONAL_TOOLS]);
export type HerdrTool = z.infer<typeof herdrTool>;
export const uuid = z.guid();

export const BindingSchema = z.object({
	key: z.string().regex(/^[0-9a-f]{16}$/),
	repoRoot: z.string().min(1),
	herdrName: herdrAgentName,
	agentId: uuid,
	handle: z.string().min(3),
	configDir: z.string().min(1),
	state: z.enum([BindingState.PendingApply, BindingState.Applied, BindingState.Unbound]),
	tools: z.array(herdrTool),
	createdAt: z.iso.datetime(),
	appliedAt: z.iso.datetime().nullable(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const HostSchema = z.object({
	branch: z.string().min(1),
	orgId: uuid,
	orgSlug: z.string().min(1),
	apiUrl: z.url(),
	hostSlug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/),
});
export type Host = z.infer<typeof HostSchema>;

/** One inbound message as the daemon sees it: metadata only, never a body. */
export interface InboundNotice {
	bindingKey: string;
	messageId: string;
	conversationId: string;
	senderId: string;
	senderHandle: string | null;
	groupHandle: string | null;
	senderOrgSlug: string | null;
	receivedAt: number;
}

export const QuarantineDecision = { Approve: "approve", Deny: "deny" } as const;
export type QuarantineDecision = (typeof QuarantineDecision)[keyof typeof QuarantineDecision];

/** The desired end state for one repo, derived from the policy file + bindings. */
export interface DesiredAgentPolicy {
	bindingKey: string;
	incoming: "accept_all" | "groups_only";
	outgoing: "send_all" | "groups_only";
	exposure: "private" | "findable";
	tools: readonly string[];
}

export const PlanStepKind = {
	CreateGroup: "create_group",
	JoinGroup: "join_group",
	DissolveGroup: "dissolve_group",
	LeaveGroup: "leave_group",
	AcceptExternalInvite: "accept_external_invite",
	SetAgentPolicy: "set_agent_policy",
	SetExposure: "set_exposure",
	PutAllow: "put_allow",
	MarkApplied: "mark_applied",
} as const;
export type PlanStepKind = (typeof PlanStepKind)[keyof typeof PlanStepKind];

export type PlanStep =
	| { kind: typeof PlanStepKind.CreateGroup; name: string; creatorKey: string; inviteeKeys: readonly string[] }
	| { kind: typeof PlanStepKind.JoinGroup; groupName: string; memberKey: string }
	| { kind: typeof PlanStepKind.DissolveGroup; groupId: string; groupName: string; memberKey: string }
	| { kind: typeof PlanStepKind.LeaveGroup; groupId: string; groupName: string; memberKey: string }
	| { kind: typeof PlanStepKind.AcceptExternalInvite; groupHandle: string; memberKey: string }
	| { kind: typeof PlanStepKind.SetAgentPolicy; memberKey: string; incoming: DesiredAgentPolicy["incoming"]; outgoing: DesiredAgentPolicy["outgoing"] }
	| { kind: typeof PlanStepKind.SetExposure; memberKey: string; exposure: DesiredAgentPolicy["exposure"] }
	| { kind: typeof PlanStepKind.PutAllow; memberKey: string; counterpartyOrgId: string }
	| { kind: typeof PlanStepKind.MarkApplied; memberKey: string; tools: readonly string[]; previous: readonly string[] };

export interface Plan {
	repoRoot: string;
	steps: readonly PlanStep[];
	groupsNeeded: number;
	groupsRemaining: number | null; // null = unlimited tier
	refusal: string | null; // non-null → apply refuses (e.g. over group quota)
	/** Stale groups no bound agent can dissolve or leave: reported, never planned, so apply does not retry them. */
	stuck: readonly string[];
}

/** Daemon IPC: NDJSON over <state>/daemon.sock. Requests and replies are zod-checked both ways. */
export const IpcMethod = {
	Status: "status",
	ForPane: "binding.forPane",
	Snapshot: "binding.snapshot",
	Bind: "binding.bind",
	Unbind: "binding.unbind",
	MarkApplied: "binding.markApplied",
	QuarantineList: "quarantine.list",
	QuarantineDecide: "quarantine.decide",
} as const;
export type IpcMethod = (typeof IpcMethod)[keyof typeof IpcMethod];

export const IpcRequestSchema = z.discriminatedUnion("method", [
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.Status), params: z.object({}) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.ForPane), params: z.object({ paneId: z.string().min(1) }) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.Snapshot), params: z.object({ repoRoot: z.string().optional() }) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.Bind), params: z.object({ paneId: z.string().min(1), name: herdrAgentName.optional() }) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.Unbind), params: z.object({ paneId: z.string().min(1) }) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.MarkApplied), params: z.object({ keys: z.array(z.string()), tools: z.record(z.string(), z.array(rineToolName)) }) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.QuarantineList), params: z.object({}) }),
	z.object({ id: z.number().int(), method: z.literal(IpcMethod.QuarantineDecide), params: z.object({ bindingKey: z.string(), senderId: uuid, decision: z.enum([QuarantineDecision.Approve, QuarantineDecision.Deny]) }) }),
]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type IpcReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
