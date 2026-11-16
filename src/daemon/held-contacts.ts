// held-contacts.ts — the one grouping of held notices into contacts. The daemon counts contacts with it and the
// pane renders them, so the count a status line shows and the rows the quarantine screen lists cannot drift.
import type { Binding, InboundNotice } from "../types.js";

/** One sender's held messages to one agent: what a single decision settles. */
export interface HeldContact {
	bindingKey: string;
	agent: string;
	senderId: string;
	senderHandle: string | null;
	groupHandle: string | null;
	messages: number;
	firstAt: number;
}

export function groupHeld(entries: readonly InboundNotice[], bindings: readonly Binding[]): HeldContact[] {
	const contacts = new Map<string, HeldContact>();
	for (const n of entries) {
		const key = `${n.bindingKey}/${n.senderId}`;
		const seen = contacts.get(key);
		if (seen === undefined) {
			const agent = bindings.find((b) => b.key === n.bindingKey)?.herdrName ?? "this agent";
			contacts.set(key, { bindingKey: n.bindingKey, agent, senderId: n.senderId, senderHandle: n.senderHandle, groupHandle: n.groupHandle, messages: 1, firstAt: n.receivedAt });
		} else {
			seen.messages += 1;
			seen.firstAt = Math.min(seen.firstAt, n.receivedAt);
			seen.groupHandle ??= n.groupHandle;
		}
	}
	return [...contacts.values()];
}
