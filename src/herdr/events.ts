// events.ts — herdr's event socket. herdr treats a connection that subscribed as push-only (a second request
// on it resets the connection), so every status subscription and the global one each own a connection, and
// a pane that does not exist rejects only its own. After any reconnect, or an events_lost, the feed
// reconciles with session.snapshot, because the frames in between are gone.
import { z } from "zod";
import { AgentInfoSchema, type AgentInfo } from "./cli.js";
import { FrameType, type HerdrEvent, HerdrEventKind, parseFrame } from "./frames.js";
import type { HerdrPort, HerdrSocket } from "./port.js";

export const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_ID = "rine:snapshot";
const PANE_NOT_FOUND = "pane_not_found";

const subscribeRequest = (id: string, subscriptions: readonly object[]): string =>
	JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } });

export function subscribeStatus(socket: HerdrSocket, paneId: string): void {
	socket.send(subscribeRequest(`rine:status:${paneId}`, [{ type: "pane.agent_status_changed", pane_id: paneId }]));
}

export function subscribeGlobal(socket: HerdrSocket): void {
	socket.send(
		subscribeRequest("rine:global", [{ type: "pane.closed" }, { type: "pane.agent_detected" }, { type: "pane.created" }]),
	);
}

const SnapshotReply = z.object({ snapshot: z.object({ agents: z.array(AgentInfoSchema) }) });

/** Every agent herdr knows, over a connection of its own that closes after the reply. */
export async function fetchSnapshot(port: HerdrPort): Promise<AgentInfo[]> {
	const socket = await port.connect();
	return new Promise<AgentInfo[]>((resolve, reject) => {
		const timer = setTimeout(() => settle(new Error("session.snapshot timed out")), SNAPSHOT_TIMEOUT_MS);
		let settled = false;
		const settle = (outcome: AgentInfo[] | Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.close();
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		socket.onClose(() => settle(new Error("socket closed before the snapshot")));
		socket.onLine((line) => {
			const frame = parseFrame(line);
			if (frame.type !== FrameType.Reply || frame.id !== SNAPSHOT_ID) return;
			const parsed = SnapshotReply.safeParse(frame.result);
			settle(parsed.success ? parsed.data.snapshot.agents : new Error(frame.error?.message ?? "bad snapshot reply"));
		});
		socket.send(JSON.stringify({ id: SNAPSHOT_ID, method: "session.snapshot", params: {} }));
	});
}

export interface FeedHandlers {
	onEvent(event: HerdrEvent): void;
	/** The authoritative state of every agent, after the feed started or reconnected. */
	onSnapshot(agents: AgentInfo[]): void;
	/** The global connection's state, which the daemon turns into its exit rule. */
	onConnection(connected: boolean): void;
	log(line: string): void;
}

export interface EventFeed {
	start(): void;
	watchPane(paneId: string): void;
	unwatchPane(paneId: string): void;
	stop(): void;
	unknownFrames(): number;
}

export function openEventFeed(port: HerdrPort, handlers: FeedHandlers): EventFeed {
	let unknown = 0;
	let stopped = false;
	const channels = new Map<string, { stop(): void }>();

	const resync = (): void => {
		fetchSnapshot(port).then(handlers.onSnapshot, (err: Error) => handlers.log(`snapshot failed: ${err.message}`));
	};

	/** A subscription that reconnects with backoff until stopped; `paneId` marks a per-pane status channel. */
	function keepSubscribed(subscribe: (socket: HerdrSocket) => void, report: ((up: boolean) => void) | null, paneId: string | null) {
		let socket: HerdrSocket | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let backoff = RECONNECT_MIN_MS;
		let done = false;
		const retry = (): void => {
			socket = null;
			report?.(false);
			if (done || stopped) return;
			timer = setTimeout(open, backoff);
			backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
		};
		const gone = (): void => {
			done = true;
			socket?.close();
			if (timer !== null) clearTimeout(timer);
			if (paneId !== null) channels.delete(paneId);
		};
		function open(): void {
			port.connect().then((conn) => {
				if (done || stopped) return conn.close();
				socket = conn;
				backoff = RECONNECT_MIN_MS;
				conn.onClose(retry);
				conn.onLine((line) => {
					const frame = parseFrame(line);
					if (frame.type === FrameType.Malformed) {
						unknown += 1;
						handlers.log(`unparseable herdr frame (${frame.reason})`);
					} else if (frame.type === FrameType.Reply && frame.error !== null) {
						handlers.log(`herdr refused ${frame.id}: ${frame.error.code}`);
						if (paneId !== null && frame.error.code === PANE_NOT_FOUND) {
							gone();
							handlers.onEvent({ kind: HerdrEventKind.PaneClosed, paneId });
						}
					} else if (frame.type === FrameType.Event && frame.event.kind === HerdrEventKind.EventsLost) {
						handlers.log("herdr dropped events (overrun); resubscribing");
						conn.close();
					} else if (frame.type === FrameType.Event) {
						handlers.onEvent(frame.event);
					}
				});
				subscribe(conn);
				report?.(true);
				resync();
			}, retry);
		}
		open();
		return { stop: gone };
	}

	return {
		start() {
			channels.set("", keepSubscribed(subscribeGlobal, handlers.onConnection, null));
		},
		watchPane(paneId) {
			if (stopped || channels.has(paneId)) return;
			channels.set(paneId, keepSubscribed((s) => subscribeStatus(s, paneId), null, paneId));
		},
		unwatchPane(paneId) {
			channels.get(paneId)?.stop();
			channels.delete(paneId);
		},
		stop() {
			stopped = true;
			for (const channel of channels.values()) channel.stop();
			channels.clear();
		},
		unknownFrames: () => unknown,
	};
}
