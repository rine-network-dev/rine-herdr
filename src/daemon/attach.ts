// attach.ts — the live side of a binding: its inbox stream, its delivery queue and its status
// subscription. Only an applied binding on a live pane is attached; detaching stops all three.
import { type AgentStatus, type Binding, BindingState } from "../types.js";
import type { Delivery } from "./delivery.js";
import { type InboxDeps, type InboxWatch, type StreamSource, StreamState, watchInbox } from "./inbound.js";

export interface PaneWatcher {
	watchPane(paneId: string): void;
	unwatchPane(paneId: string): void;
}

export interface StreamInfo {
	bindingKey: string;
	herdrName: string;
	paneId: string | null;
	state: StreamState;
}

export interface Attachments {
	attach(binding: Binding, paneId: string, status: AgentStatus): void;
	detach(bindingKey: string, paneGone: boolean): Promise<void>;
	keyForPane(paneId: string): string | undefined;
	streams(): StreamInfo[];
	dropped(): number;
	close(): void;
}

export interface AttachDeps extends Pick<InboxDeps, "host" | "now" | "log" | "isAppliedInvite"> {
	source: StreamSource;
	delivery: Delivery;
	watcher: PaneWatcher;
}

interface Entry {
	herdrName: string;
	paneId: string;
	watch: InboxWatch;
}

export function createAttachments(deps: AttachDeps): Attachments {
	const entries = new Map<string, Entry>();
	const ended = new Map<string, StreamInfo>();
	let droppedByEnded = 0;

	const detach = async (key: string, paneGone: boolean): Promise<void> => {
		const entry = entries.get(key);
		ended.delete(key);
		if (entry === undefined) return;
		entry.watch.stop();
		droppedByEnded += entry.watch.dropped();
		entries.delete(key);
		deps.watcher.unwatchPane(entry.paneId);
		await deps.delivery.detach(key, paneGone);
	};

	return {
		attach(binding, paneId, status) {
			if (binding.state !== BindingState.Applied) return;
			const current = entries.get(binding.key);
			if (current !== undefined && current.paneId === paneId && current.watch.state() === StreamState.Streaming) {
				deps.delivery.attach(binding, paneId, status);
				return;
			}
			if (current !== undefined) void detach(binding.key, true);
			deps.delivery.attach(binding, paneId, status);
			deps.watcher.watchPane(paneId);
			const watch = watchInbox(binding, {
				...deps,
				onNotice: (notice) =>
					void deps.delivery.onNotice(notice).catch((err: Error) => deps.log(`binding ${binding.key}: notice failed: ${err.message}`)),
				onEnded: (state, key) => {
					ended.set(key, { bindingKey: key, herdrName: binding.herdrName, paneId, state });
					void deps.delivery.detach(key, true);
					deps.watcher.unwatchPane(paneId);
				},
			});
			entries.set(binding.key, { herdrName: binding.herdrName, paneId, watch });
		},
		detach,
		keyForPane(paneId) {
			for (const [key, entry] of entries) if (entry.paneId === paneId) return key;
			return undefined;
		},
		streams: () => [
			...[...entries].map(([bindingKey, e]) => ended.get(bindingKey) ?? { bindingKey, herdrName: e.herdrName, paneId: e.paneId, state: e.watch.state() }),
		],
		dropped: () => droppedByEnded + [...entries.values()].reduce((sum, e) => sum + e.watch.dropped(), 0),
		close() {
			for (const entry of entries.values()) entry.watch.stop();
			entries.clear();
			ended.clear();
		},
	};
}
