// frames.ts — herdr's pushed event lines, parsed. The wire shape is `{"event":<name>,"data":{...}}` with no
// id. The pushed `event` name is NOT always the subscription type: status changes keep the dotted name,
// the rest are underscored (as recorded from a live herdr in tests/herdr/fixtures/frames.ndjson). A subscription's own reply carries an `id`.
import { z } from "zod";
import { AgentStatus } from "../types.js";

export const HerdrEventName = {
	Status: "pane.agent_status_changed",
	PaneClosed: "pane_closed",
	PaneCreated: "pane_created",
	AgentDetected: "pane_agent_detected",
	EventsLost: "events_lost",
} as const;

export const HerdrEventKind = {
	Status: "status",
	PaneClosed: "pane_closed",
	PaneCreated: "pane_created",
	AgentDetected: "agent_detected",
	AgentReleased: "agent_released",
	EventsLost: "events_lost",
} as const;

export type HerdrEvent =
	| { kind: typeof HerdrEventKind.Status; paneId: string; status: AgentStatus }
	| { kind: typeof HerdrEventKind.PaneClosed; paneId: string }
	| { kind: typeof HerdrEventKind.PaneCreated; paneId: string }
	| { kind: typeof HerdrEventKind.AgentDetected; paneId: string }
	| { kind: typeof HerdrEventKind.AgentReleased; paneId: string }
	| { kind: typeof HerdrEventKind.EventsLost };

export const FrameType = { Event: "event", Reply: "reply", Ignored: "ignored", Malformed: "malformed" } as const;

export type Frame =
	| { type: typeof FrameType.Event; event: HerdrEvent }
	| { type: typeof FrameType.Reply; id: string; result: unknown; error: { code: string; message: string } | null }
	| { type: typeof FrameType.Ignored }
	| { type: typeof FrameType.Malformed; reason: string };

const paneData = z.object({ pane_id: z.string().min(1) });
// pane_created nests the pane (herdr's PaneInfo); pane_closed carries the id flat.
const createdData = z.object({ pane: paneData });
const statusData = paneData.extend({ agent_status: z.enum(AgentStatus).catch(AgentStatus.Unknown) });
const detectedData = paneData.extend({ released: z.boolean().optional() });

const Line = z.union([
	z.object({ event: z.string(), data: z.unknown().optional() }),
	z.object({
		id: z.string(),
		result: z.unknown().optional(),
		error: z.object({ code: z.string(), message: z.string() }).optional(),
	}),
]);

function eventFrame(name: string, data: unknown): Frame {
	const bad = (reason: string): Frame => ({ type: FrameType.Malformed, reason: `${name}: ${reason}` });
	switch (name) {
		case HerdrEventName.EventsLost:
			return { type: FrameType.Event, event: { kind: HerdrEventKind.EventsLost } };
		case HerdrEventName.Status: {
			const p = statusData.safeParse(data);
			if (!p.success) return bad("bad data");
			return { type: FrameType.Event, event: { kind: HerdrEventKind.Status, paneId: p.data.pane_id, status: p.data.agent_status } };
		}
		case HerdrEventName.PaneClosed: {
			const p = paneData.safeParse(data);
			if (!p.success) return bad("bad data");
			return { type: FrameType.Event, event: { kind: HerdrEventKind.PaneClosed, paneId: p.data.pane_id } };
		}
		case HerdrEventName.PaneCreated: {
			const p = createdData.safeParse(data);
			if (!p.success) return bad("bad data");
			return { type: FrameType.Event, event: { kind: HerdrEventKind.PaneCreated, paneId: p.data.pane.pane_id } };
		}
		case HerdrEventName.AgentDetected: {
			const p = detectedData.safeParse(data);
			if (!p.success) return bad("bad data");
			const kind = p.data.released === true ? HerdrEventKind.AgentReleased : HerdrEventKind.AgentDetected;
			return { type: FrameType.Event, event: { kind, paneId: p.data.pane_id } };
		}
		default:
			return { type: FrameType.Ignored };
	}
}

/** One socket line to a Frame. Never throws: a line that is not herdr's shape is `malformed`. */
export function parseFrame(line: string): Frame {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return { type: FrameType.Malformed, reason: "not json" };
	}
	const parsed = Line.safeParse(json);
	if (!parsed.success) return { type: FrameType.Malformed, reason: "unknown shape" };
	if ("event" in parsed.data) return eventFrame(parsed.data.event, parsed.data.data);
	return { type: FrameType.Reply, id: parsed.data.id, result: parsed.data.result, error: parsed.data.error ?? null };
}
