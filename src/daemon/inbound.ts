// inbound.ts — one SSE stream per applied binding, in peek mode, so the daemon marks nothing delivered.
// A frame becomes an InboundNotice: ids, handles and a timestamp. The body is never read, and the
// notice type has no field to hold one.
import { isGroupInvite, isPrincipalRevokedError } from "@rine-network/core";
import { AsyncRineClient, RESERVED_MESSAGE_TYPES, type MessageTypeString } from "@rine-network/sdk";
import { z } from "zod";
import { type Binding, type Host, type InboundNotice, uuid } from "../types.js";

export const StreamState = { Streaming: "streaming", Revoked: "revoked", Failed: "failed", Stopped: "stopped" } as const;
export type StreamState = (typeof StreamState)[keyof typeof StreamState];

export interface RawEvent {
	type: string;
	data: string;
}

export type StreamSource = (binding: Binding, signal: AbortSignal) => AsyncIterable<RawEvent>;

/** The real source: an agent-only client, so the owner dir on the host can never make it act as the org. */
export function sdkStreamSource(host: Host): StreamSource {
	return (binding, signal) =>
		new AsyncRineClient({ configDir: binding.configDir, agentOnly: true, apiUrl: host.apiUrl }).stream({ signal, agent: binding.agentId });
}

const Frame = z.object({
	id: uuid,
	conversation_id: uuid,
	from_agent_id: uuid,
	type: z.string(),
	direction: z.enum(["sent", "received"]).optional(),
	sender_handle: z.string().nullish(),
	group_handle: z.string().nullish(),
});

/** The sender's org slug, only when the sender's domain is our own handle's domain with another first label. */
function orgSlugOf(senderHandle: string | null, ownHandle: string): string | null {
	const [slug, ...suffix] = (senderHandle?.split("@")[1] ?? "").split(".");
	const ownSuffix = (ownHandle.split("@")[1] ?? "").split(".").slice(1);
	if (!slug || suffix.length === 0 || suffix.join(".") !== ownSuffix.join(".")) return null;
	return slug;
}

export interface InboxDeps {
	host: Host;
	source: StreamSource;
	now(): number;
	/** An invitation `apply` already answered: it wakes nobody and is never held. */
	isAppliedInvite(binding: Binding, inviter: { id: string; handle: string | null }): boolean;
	onNotice(notice: InboundNotice): void;
	/** The stream ended for good: the principal was revoked, or the stream failed. */
	onEnded(state: StreamState, bindingKey: string): void;
	log(line: string): void;
}

export interface InboxWatch {
	state(): StreamState;
	/** Frames that were not a message the daemon could use. */
	dropped(): number;
	stop(): void;
}

export function watchInbox(binding: Binding, deps: InboxDeps): InboxWatch {
	const abort = new AbortController();
	let state: StreamState = StreamState.Streaming;
	let dropped = 0;

	const noticeOf = (event: RawEvent): InboundNotice | null => {
		if (event.type !== "message") return null;
		let frame: z.infer<typeof Frame>;
		try {
			frame = Frame.parse(JSON.parse(event.data));
		} catch {
			dropped += 1;
			deps.log(`binding ${binding.key}: a stream frame was not a usable message`);
			return null;
		}
		if (frame.direction !== undefined && frame.direction !== "received") return null;
		if (RESERVED_MESSAGE_TYPES.has(frame.type as MessageTypeString)) return null;
		if (frame.from_agent_id === binding.agentId) return null;
		const senderHandle = frame.sender_handle ?? null;
		// The type is only a filter here; it is never typed into a pane.
		if (isGroupInvite(frame.type) && deps.isAppliedInvite(binding, { id: frame.from_agent_id, handle: senderHandle })) return null;
		return {
			bindingKey: binding.key,
			messageId: frame.id,
			conversationId: frame.conversation_id,
			senderId: frame.from_agent_id,
			senderHandle,
			groupHandle: frame.group_handle ?? null,
			senderOrgSlug: orgSlugOf(senderHandle, binding.handle),
			receivedAt: deps.now(),
		};
	};

	const run = async (): Promise<void> => {
		try {
			for await (const event of deps.source(binding, abort.signal)) {
				const notice = noticeOf(event);
				if (notice !== null) deps.onNotice(notice);
			}
			state = StreamState.Stopped;
		} catch (err) {
			if (abort.signal.aborted) return;
			state = isPrincipalRevokedError(err) ? StreamState.Revoked : StreamState.Failed;
			deps.log(`binding ${binding.key}: stream ended (${state}): ${(err as Error).message}`);
			deps.onEnded(state, binding.key);
		}
	};
	void run();

	return {
		state: () => state,
		dropped: () => dropped,
		stop() {
			abort.abort();
			state = StreamState.Stopped;
		},
	};
}
