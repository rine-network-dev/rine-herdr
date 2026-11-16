import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FrameType, HerdrEventKind, parseFrame } from "../../src/herdr/frames.js";
import { AgentStatus } from "../../src/types.js";

const recording = readFileSync(join(__dirname, "fixtures/frames.ndjson"), "utf8")
	.split("\n")
	.filter(Boolean);

describe("herdr frames", () => {
	it("parseFrame_probeRecording_everyLineParses", () => {
		const frames = recording.map(parseFrame);
		expect(frames.filter((f) => f.type === FrameType.Malformed)).toEqual([]);
		expect(frames[0]).toMatchObject({ type: FrameType.Reply, id: "probe:subscribe", error: null });
		const statuses = frames.flatMap((f) => (f.type === FrameType.Event && f.event.kind === HerdrEventKind.Status ? [f.event.status] : []));
		expect(statuses).toEqual([
			AgentStatus.Working, AgentStatus.Idle, AgentStatus.Working, AgentStatus.Blocked,
			AgentStatus.Idle, AgentStatus.Blocked, AgentStatus.Idle,
		]);
		expect(frames).toContainEqual({ type: FrameType.Event, event: { kind: HerdrEventKind.PaneCreated, paneId: "w1:p3" } });
		expect(frames.at(-1)).toEqual({ type: FrameType.Event, event: { kind: HerdrEventKind.PaneClosed, paneId: "w1:p2" } });
	});

	it("parseFrame_releasedDetection_isAgentReleased", () => {
		const line = JSON.stringify({ event: "pane_agent_detected", data: { pane_id: "w1:p1", released: true } });
		expect(parseFrame(line)).toEqual({ type: FrameType.Event, event: { kind: HerdrEventKind.AgentReleased, paneId: "w1:p1" } });
	});

	it("parseFrame_unknownEvent_isIgnored", () => {
		expect(parseFrame('{"event":"tab_renamed","data":{}}')).toEqual({ type: FrameType.Ignored });
	});

	it("parseFrame_unknownStatusString_mapsToUnknown", () => {
		const line = '{"event":"pane.agent_status_changed","data":{"pane_id":"p","agent_status":"napping"}}';
		expect(parseFrame(line)).toMatchObject({ event: { status: AgentStatus.Unknown } });
	});

	it("parseFrame_garbage_neverThrows", () => {
		for (const line of ["", "{", "[]", "null", '{"event":5}', '{"event":"pane_closed","data":{}}', "\u0000\u001b[31m"]) {
			expect(parseFrame(line).type).toBe(FrameType.Malformed);
		}
	});
});
