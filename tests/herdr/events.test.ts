import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FeedHandlers, openEventFeed, RECONNECT_MIN_MS } from "../../src/herdr/events.js";
import { type HerdrEvent, HerdrEventKind } from "../../src/herdr/frames.js";
import type { AgentInfo } from "../../src/herdr/cli.js";
import { FakePort, type FakeSocket } from "./fake-port.js";

const snapshotReply = (agents: object[]) => ({ id: "rine:snapshot", result: { snapshot: { agents } } });
const agent = { pane_id: "w1:p1", workspace_id: "w1", name: "dev", agent_status: "idle" };

function harness() {
	const port = new FakePort();
	const events: HerdrEvent[] = [];
	const snapshots: AgentInfo[][] = [];
	const connection: boolean[] = [];
	const logs: string[] = [];
	const handlers: FeedHandlers = {
		onEvent: (e) => void events.push(e),
		onSnapshot: (a) => void snapshots.push(a),
		onConnection: (up) => void connection.push(up),
		log: (l) => void logs.push(l),
	};
	return { port, events, snapshots, connection, logs, feed: openEventFeed(port, handlers) };
}

/** Lets pending promise callbacks (connect, snapshot) run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Answers every snapshot connection that is waiting. */
async function answerSnapshots(port: FakePort, agents: object[]) {
	for (const s of port.sockets) {
		if (s.sent.some((l) => l.includes("session.snapshot")) && !s.closed) s.emit(snapshotReply(agents));
	}
	await settle();
}

describe("event feed", () => {
	beforeEach(() => void vi.useFakeTimers());
	afterEach(() => void vi.useRealTimers());

	it("start_opensGlobalSubscriptionAndSnapshotOnSeparateConnections", async () => {
		const h = harness();
		h.feed.start();
		await settle();
		expect(h.port.socketsSubscribedTo("pane.closed")).toHaveLength(1);
		const [global] = h.port.socketsSubscribedTo("pane.closed");
		expect(global?.requests()).toHaveLength(1);
		await answerSnapshots(h.port, [agent]);
		expect(h.snapshots).toHaveLength(1);
		expect(h.snapshots[0]?.[0]?.paneId).toBe("w1:p1");
		expect(h.connection).toEqual([true]);
	});

	it("watchPane_ownsItsConnectionAndForwardsStatusEvents", async () => {
		const h = harness();
		h.feed.watchPane("w1:p1");
		await settle();
		const [socket] = h.port.socketsSubscribedTo("pane.agent_status_changed");
		expect(socket?.requests()[0]?.params).toEqual({ subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }] });
		socket?.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } });
		expect(h.events).toEqual([{ kind: HerdrEventKind.Status, paneId: "w1:p1", status: "working" }]);
	});

	it("watchPane_samePaneTwice_subscribesOnce", async () => {
		const h = harness();
		h.feed.watchPane("w1:p1");
		h.feed.watchPane("w1:p1");
		await settle();
		expect(h.port.socketsSubscribedTo("pane.agent_status_changed")).toHaveLength(1);
	});

	it("paneNotFoundReply_closesOnlyThatPaneAndEmitsPaneClosed", async () => {
		const h = harness();
		h.feed.start();
		h.feed.watchPane("w1:gone");
		h.feed.watchPane("w1:p1");
		await settle();
		const [bad] = h.port.sockets.filter((s) => s.sent.some((l) => l.includes("w1:gone")));
		bad?.emit({ id: "rine:status:w1:gone", error: { code: "pane_not_found", message: "no such pane" } });
		expect(h.events).toEqual([{ kind: HerdrEventKind.PaneClosed, paneId: "w1:gone" }]);
		expect(bad?.closed).toBe(true);
		const live = h.port.sockets.filter((s) => !s.closed && s.sent.some((l) => l.includes("w1:p1")));
		expect(live).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.port.sockets.filter((s) => s.sent.some((l) => l.includes("w1:gone")))).toHaveLength(1);
	});

	it("eventsLost_closesTheConnectionThenResubscribesAndSnapshots", async () => {
		const h = harness();
		h.feed.start();
		await settle();
		const [first] = h.port.socketsSubscribedTo("pane.closed");
		first?.emit({ event: "events_lost", data: {} });
		expect(first?.closed).toBe(true);
		await vi.advanceTimersByTimeAsync(RECONNECT_MIN_MS);
		expect(h.port.socketsSubscribedTo("pane.closed")).toHaveLength(2);
		const snapshotsAsked = h.port.sockets.filter((s) => s.sent.some((l) => l.includes("session.snapshot")));
		expect(snapshotsAsked.length).toBeGreaterThanOrEqual(2);
		expect(h.connection).toEqual([true, false, true]);
	});

	it("malformedLine_isCountedLoggedAndTheStreamContinues", async () => {
		const h = harness();
		h.feed.watchPane("w1:p1");
		await settle();
		const [socket] = h.port.sockets as FakeSocket[];
		socket?.emit("this is not json");
		socket?.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } });
		expect(h.feed.unknownFrames()).toBe(1);
		expect(h.logs.some((l) => l.includes("unparseable"))).toBe(true);
		expect(h.events).toHaveLength(1);
	});

	it("unreachableSocket_retriesWithBackoffAndReportsDown", async () => {
		const h = harness();
		h.port.reachable = false;
		h.feed.start();
		await settle();
		expect(h.port.sockets).toHaveLength(0);
		h.port.reachable = true;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.port.socketsSubscribedTo("pane.closed")).toHaveLength(1);
		expect(h.connection.at(-1)).toBe(true);
	});

	it("stop_closesEverySocketAndStopsReconnecting", async () => {
		const h = harness();
		h.feed.start();
		h.feed.watchPane("w1:p1");
		await settle();
		h.feed.stop();
		const count = h.port.sockets.length;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(h.port.sockets).toHaveLength(count);
		expect(h.port.sockets.filter((s) => !s.closed)).toEqual([]);
	});

	it("unwatchPane_closesThePaneConnection", async () => {
		const h = harness();
		h.feed.watchPane("w1:p1");
		await settle();
		h.feed.unwatchPane("w1:p1");
		expect(h.port.sockets[0]?.closed).toBe(true);
	});
});
