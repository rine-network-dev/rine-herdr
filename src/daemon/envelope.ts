// envelope.ts — the only text the daemon ever types into a pane. It carries ids and a validated handle,
// never a subject, a body, metadata or any other wire text: a sender who controls those must not get
// a word into an agent's prompt.
import { SenderClass, uuid } from "../types.js";

const HANDLE_RE = /^#?[a-z0-9][a-z0-9-]{0,62}@[a-z0-9][a-z0-9.-]{0,252}$/;
const UNRECOGNISED_SENDER = "an unrecognised sender";

export interface Announced {
	messageId: string;
	conversationId: string;
	senderHandle: string | null;
	groupHandle: string | null;
	class: SenderClass;
}

export function safeHandle(handle: string | null): string | null {
	return handle !== null && HANDLE_RE.test(handle) ? handle : null;
}

function classLabel(item: Announced): string {
	switch (item.class) {
		case SenderClass.SameOrg:
			return "same org";
		case SenderClass.Group: {
			const group = safeHandle(item.groupHandle);
			return group === null ? "group" : `group ${group}`;
		}
		case SenderClass.ExternalAllowlisted:
			return "external, allowlisted";
		case SenderClass.ExternalApproved:
			return "external, approved";
	}
}

/** A burst names this many messages in full; the rest are only counted. */
export const BURST_LISTED = 3;

/** The validated sender and class of one notice, as both forms print them. */
const whoOf = (item: Announced): string => `${safeHandle(item.senderHandle) ?? UNRECOGNISED_SENDER} (${classLabel(item)})`;

/** `rine_read` takes `message_id`, so that is the name the agent is told. */
const readCall = (item: Announced): string => `rine_read message_id ${uuid.parse(item.messageId)}`;

/**
 * One notice gets the single form, several the burst form: the first few in full, then a count. Both are one
 * line. `ownHandle` is the bound agent's own handle.
 */
export function renderEnvelope(items: readonly Announced[], ownHandle: string): string {
	const own = safeHandle(ownHandle) ?? "this agent";
	const [first] = items;
	if (first === undefined) throw new Error("renderEnvelope: nothing to announce");
	if (items.length === 1) {
		return `rine: new message for ${own} from ${whoOf(first)}, thread ${uuid.parse(first.conversationId)}. Read it with ${readCall(first)}.`;
	}
	const listed = items.slice(0, BURST_LISTED).map((item) => `${readCall(item)} from ${whoOf(item)}`);
	const more = items.length - listed.length;
	if (more > 0) listed.push(`+${more} more; rine_inbox lists all`);
	return `rine: ${items.length} new messages for ${own}: ${listed.join("; ")}.`;
}
