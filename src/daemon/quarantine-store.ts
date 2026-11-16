// quarantine-store.ts — held notices, approvals and denials, persisted to quarantine.json. The daemon is
// the only writer. Everything stored is metadata: no message body ever reaches the daemon.
import { readFileSync } from "node:fs";
import { writeAtomic } from "@rine-network/core";
import { z } from "zod";
import { type InboundNotice, QuarantineDecision, uuid } from "../types.js";
import { groupHeld } from "./held-contacts.js";

export const MAX_HELD = 500;

export const NoticeSchema = z.object({
	bindingKey: z.string(),
	messageId: uuid,
	conversationId: uuid,
	senderId: uuid,
	senderHandle: z.string().nullable(),
	groupHandle: z.string().nullable(),
	senderOrgSlug: z.string().nullable(),
	receivedAt: z.number(),
});

const Pair = z.object({ bindingKey: z.string(), senderId: uuid });
const FileSchema = z.object({
	held: z.array(NoticeSchema).default([]),
	approvals: z.array(Pair).default([]),
	denials: z.array(Pair).default([]),
});
type FileState = z.infer<typeof FileSchema>;

export interface QuarantineStore {
	/** False when the message is already held. */
	hold(notice: InboundNotice): boolean;
	list(): readonly InboundNotice[];
	/** How many senders (per agent) are held: one contact however many messages it sent. */
	contacts(): number;
	approvedSenders(bindingKey: string): ReadonlySet<string>;
	approve(bindingKey: string, senderId: string): void;
	isDenied(bindingKey: string, senderId: string): boolean;
	/** Records the decision and returns the held notices it settles: released on approve, dropped on deny. */
	decide(bindingKey: string, senderId: string, decision: QuarantineDecision): InboundNotice[];
}

function load(path: string, log: (line: string) => void): FileState {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { held: [], approvals: [], denials: [] };
	}
	try {
		return FileSchema.parse(JSON.parse(text));
	} catch {
		log(`${path} is unreadable; starting with an empty quarantine`);
		return { held: [], approvals: [], denials: [] };
	}
}

export function openQuarantineStore(path: string, log: (line: string) => void): QuarantineStore {
	let state = load(path, log);
	// A failed write keeps the in-memory state and logs: the daemon must outlive a full or unwritable disk.
	const save = (): void => {
		try {
			writeAtomic(path, JSON.stringify(state));
		} catch (err) {
			log(`${path} could not be written (${(err as Error).message}); keeping the quarantine in memory`);
		}
	};
	const same = (a: { bindingKey: string; senderId: string }, key: string, sender: string): boolean =>
		a.bindingKey === key && a.senderId === sender;
	const add = (list: FileState["approvals"], key: string, sender: string): FileState["approvals"] =>
		list.some((p) => same(p, key, sender)) ? list : [...list, { bindingKey: key, senderId: sender }];
	return {
		hold(notice) {
			if (state.held.some((n) => n.bindingKey === notice.bindingKey && n.messageId === notice.messageId)) return false;
			state = { ...state, held: [...state.held, notice].slice(-MAX_HELD) };
			save();
			return true;
		},
		list: () => state.held,
		contacts: () => groupHeld(state.held, []).length,
		approvedSenders: (key) => new Set(state.approvals.filter((p) => p.bindingKey === key).map((p) => p.senderId)),
		approve(key, sender) {
			state = { ...state, approvals: add(state.approvals, key, sender) };
			save();
		},
		isDenied: (key, sender) => state.denials.some((p) => same(p, key, sender)),
		decide(key, sender, decision) {
			const settled = state.held.filter((n) => same(n, key, sender));
			const approved = decision === QuarantineDecision.Approve;
			state = {
				held: state.held.filter((n) => !same(n, key, sender)),
				approvals: approved ? add(state.approvals, key, sender) : state.approvals.filter((p) => !same(p, key, sender)),
				denials: approved ? state.denials.filter((p) => !same(p, key, sender)) : add(state.denials, key, sender),
			};
			save();
			return settled;
		},
	};
}
