// fakes.ts — an in-memory DaemonClient that records what the pane asks of the daemon.
import type { DaemonClient } from "../../src/cli/daemon-client.js";
import type { Binding, InboundNotice } from "../../src/types.js";
import { binding } from "../mcp/fixtures.js";

export const NOTICE: InboundNotice = {
	bindingKey: "0123456789abcdef",
	messageId: "7c1e5b0a-0000-4000-8000-0000000000a1",
	conversationId: "7c1e5b0a-0000-4000-8000-0000000000a2",
	senderId: "7c1e5b0a-0000-4000-8000-0000000000a3",
	senderHandle: "bot@other.rine.network",
	groupHandle: null,
	senderOrgSlug: "other",
	receivedAt: 1,
};

export function fakeClient(bindings: Binding[] = [binding("applied", ["rine_whoami"])]): DaemonClient & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		status: async () => ({ pid: 42, herdrConnected: true, unknownFrames: 1, droppedFrames: 0, held: 1, streams: [{ bindingKey: "k", herdrName: "lead", paneId: "w1:p1", state: "streaming" as const }] }),
		forPane: async () => bindings[0] ?? null,
		snapshot: async () => bindings,
		bind: async (paneId, name) => (calls.push(`bind ${paneId} ${name ?? ""}`), { binding: binding("pending_apply"), warnings: [] }),
		unbind: async (paneId) => (calls.push(`unbind ${paneId}`), binding("unbound")),
		markApplied: async () => {},
		quarantineList: async () => [NOTICE],
		quarantineDecide: async (key, sender, decision) => (calls.push(`decide ${key} ${sender} ${decision}`), 1),
	};
}
