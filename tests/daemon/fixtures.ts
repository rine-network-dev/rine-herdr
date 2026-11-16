// fixtures.ts — a host, a binding and notices that daemon tests share.
import type { PolicyFile } from "../../src/policy/schema.js";
import { parsePolicy } from "../../src/policy/schema.js";
import { type Binding, BindingState, type Host, type InboundNotice } from "../../src/types.js";

export const HOST: Host = {
	branch: "dev-laptop",
	orgId: "11111111-1111-4111-8111-111111111111",
	orgSlug: "acme",
	apiUrl: "https://api.test.rine",
	hostSlug: "laptop",
};

export const AGENT_ID = "22222222-2222-4222-8222-222222222222";
export const SENDER_ID = "33333333-3333-4333-8333-333333333333";

export const BINDING: Binding = {
	key: "0123456789abcdef",
	repoRoot: "/repo",
	herdrName: "dev",
	agentId: AGENT_ID,
	handle: "demo-dev@acme.rine.network",
	configDir: "/state/agents/0123456789abcdef",
	state: BindingState.Applied,
	tools: [],
	createdAt: "2026-11-13T10:00:00.000Z",
	appliedAt: "2026-11-13T10:00:00.000Z",
};

export const uuidN = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export function notice(n: number, over: Partial<InboundNotice> = {}): InboundNotice {
	return {
		bindingKey: BINDING.key,
		messageId: uuidN(n),
		conversationId: uuidN(1000 + n),
		senderId: SENDER_ID,
		senderHandle: "peer@acme.rine.network",
		groupHandle: null,
		senderOrgSlug: "acme",
		receivedAt: 0,
		...over,
	};
}

/** An external sender: a different org slug and no group. */
export const external = (n: number, over: Partial<InboundNotice> = {}): InboundNotice =>
	notice(n, { senderHandle: "bot@other.rine.network", senderOrgSlug: "other", ...over });

export const policyOf = (toml = ""): PolicyFile => parsePolicy(toml);
