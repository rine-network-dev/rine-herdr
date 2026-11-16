import { PrincipalRevokedError, RevokedScope } from "@rine-network/core";
import { RESERVED_MESSAGE_TYPES } from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import { type InboxDeps, type RawEvent, type StreamSource, StreamState, watchInbox } from "../../src/daemon/inbound.js";
import type { InboundNotice } from "../../src/types.js";
import { AGENT_ID, BINDING, HOST, SENDER_ID, uuidN } from "./fixtures.js";

const CANARY = "CANARY-CIPHERTEXT-9f3a";

const frame = (over: Record<string, unknown> = {}): RawEvent => ({
	type: "message",
	data: JSON.stringify({
		id: uuidN(1),
		conversation_id: uuidN(2),
		from_agent_id: SENDER_ID,
		type: "rine.v1.text",
		direction: "received",
		sender_handle: "bot@other.rine.network",
		group_handle: null,
		encrypted_payload: CANARY,
		subject: CANARY,
		...over,
	}),
});

async function run(events: Array<RawEvent | Error>, isAppliedInvite: InboxDeps["isAppliedInvite"] = () => false) {
	const notices: InboundNotice[] = [];
	const ended: StreamState[] = [];
	const logs: string[] = [];
	const source: StreamSource = async function* () {
		for (const e of events) {
			if (e instanceof Error) throw e;
			yield e;
		}
	};
	const deps: InboxDeps = {
		host: HOST,
		source,
		now: () => 42,
		isAppliedInvite,
		onNotice: (n) => void notices.push(n),
		onEnded: (state) => void ended.push(state),
		log: (l) => void logs.push(l),
	};
	const watch = watchInbox(BINDING, deps);
	await new Promise((r) => setTimeout(r, 5));
	return { watch, notices, ended, logs };
}

describe("watchInbox", () => {
	it("frameWithBody_yieldsANoticeThatCarriesNoBodyAtAll", async () => {
		const { notices } = await run([frame()]);
		expect(notices).toEqual([
			{
				bindingKey: BINDING.key,
				messageId: uuidN(1),
				conversationId: uuidN(2),
				senderId: SENDER_ID,
				senderHandle: "bot@other.rine.network",
				groupHandle: null,
				senderOrgSlug: "other",
				receivedAt: 42,
			},
		]);
		expect(JSON.stringify(notices)).not.toContain(CANARY);
	});

	it("sentDirectionFrame_yieldsNothing", async () => {
		expect((await run([frame({ direction: "sent" })])).notices).toEqual([]);
	});

	it("reservedTypeFrame_yieldsNothing", async () => {
		const [reserved] = [...RESERVED_MESSAGE_TYPES];
		expect((await run([frame({ type: reserved })])).notices).toEqual([]);
	});

	it("groupInviteApplyAlreadyAnswered_yieldsNothing", async () => {
		const asked: unknown[] = [];
		const { notices } = await run([frame({ type: "rine.v1.group_invite" })], (binding, inviter) => {
			asked.push([binding.key, inviter]);
			return true;
		});
		expect(notices).toEqual([]);
		expect(asked).toEqual([[BINDING.key, { id: SENDER_ID, handle: "bot@other.rine.network" }]]);
	});

	it("groupInviteTheRuleDoesNotRecognise_isAnOrdinaryNotice", async () => {
		expect((await run([frame({ type: "rine.v1.group_invite" })])).notices).toHaveLength(1);
	});

	it("otherTypes_neverAskWhetherTheyAreAnAppliedInvite", async () => {
		const { notices } = await run([frame()], () => {
			throw new Error("asked");
		});
		expect(notices).toHaveLength(1);
	});

	it("ownMessage_yieldsNothing", async () => {
		expect((await run([frame({ from_agent_id: AGENT_ID })])).notices).toEqual([]);
	});

	it("nonMessageEvent_yieldsNothingAndIsNotCountedAsDropped", async () => {
		const { notices, watch } = await run([{ type: "ping", data: "{}" }]);
		expect(notices).toEqual([]);
		expect(watch.dropped()).toBe(0);
	});

	it("unusableFrame_isCountedAndLoggedAndTheStreamGoesOn", async () => {
		const { notices, watch, logs } = await run([{ type: "message", data: "not json" }, frame({ id: "no-uuid" }), frame()]);
		expect(watch.dropped()).toBe(2);
		expect(logs).toHaveLength(2);
		expect(notices).toHaveLength(1);
	});

	it("senderOrgSlug_onlyForHandlesOnOurOwnDomainFamily", async () => {
		const { notices } = await run([
			frame({ id: uuidN(3), sender_handle: "peer@acme.rine.network" }),
			frame({ id: uuidN(4), sender_handle: "peer@acme.evil.example" }),
			frame({ id: uuidN(5), sender_handle: null }),
		]);
		expect(notices.map((n) => n.senderOrgSlug)).toEqual(["acme", null, null]);
	});

	it("revokedPrincipal_endsTheStreamAndMarksItRevoked", async () => {
		const { watch, ended } = await run([new PrincipalRevokedError(RevokedScope.Agent, "revoked")]);
		expect(watch.state()).toBe(StreamState.Revoked);
		expect(ended).toEqual([StreamState.Revoked]);
	});

	it("otherError_endsTheStreamAsFailed", async () => {
		const { watch, ended } = await run([new Error("socket hang up")]);
		expect(watch.state()).toBe(StreamState.Failed);
		expect(ended).toEqual([StreamState.Failed]);
	});

	it("stop_abortsTheSourceAndReportsNothing", async () => {
		let signal: AbortSignal | undefined;
		const source: StreamSource = async function* (_b, s) {
			signal = s;
			await new Promise((_, reject) => s.addEventListener("abort", () => reject(new Error("aborted"))));
			yield { type: "message", data: "" };
		};
		const ended: StreamState[] = [];
		const watch = watchInbox(BINDING, { host: HOST, source, now: () => 0, isAppliedInvite: () => false, onNotice() {}, onEnded: (s) => void ended.push(s), log() {} });
		watch.stop();
		await new Promise((r) => setTimeout(r, 5));
		expect(signal?.aborted).toBe(true);
		expect(watch.state()).toBe(StreamState.Stopped);
		expect(ended).toEqual([]);
	});
});
