// core.ts — assembles the daemon: stores, delivery, attachments, the herdr event feed and the IPC handler.
// main.ts owns the process around it (pidfile, socket, exit rule); this owns what runs inside.
import { homedir } from "node:os";
import { openEventFeed, type EventFeed } from "../herdr/events.js";
import type { HerdrPort } from "../herdr/port.js";
import { BindingStore } from "../identity/bindings.js";
import type { StatePaths } from "../identity/paths.js";
import { loadPolicy, parsePolicy } from "../policy/schema.js";
import { type Binding, BindingState, type Host, type IpcRequest } from "../types.js";
import { createAttachments } from "./attach.js";
import { leaseVerdict } from "./cc-lease.js";
import { createDelivery } from "./delivery.js";
import { createHandler } from "./handlers.js";
import type { StreamSource } from "./inbound.js";
import { isAppliedInvite } from "./quarantine.js";
import { openQuarantineStore } from "./quarantine-store.js";
import { createReconciler } from "./reconcile.js";
import { createSenderOrgResolver, type SenderOrgDeps } from "./sender-org.js";
import { agentOfPane } from "./registry.js";
import { createWakeBudget } from "./wake-budget.js";

export interface CoreDeps {
	paths: StatePaths;
	host: Host;
	port: HerdrPort;
	source: StreamSource;
	log(line: string): void;
	now?: () => number;
	home?: string;
	/** Test seam: how a sender's org id is read. */
	orgLookup?: SenderOrgDeps["lookup"];
	/** The herdr event connection went up or down. */
	onConnection(connected: boolean): void;
}

export interface DaemonCore {
	handle(request: IpcRequest): Promise<unknown>;
	start(): void;
	close(): void;
}

export function createDaemonCore(deps: CoreDeps): DaemonCore {
	const { paths, host, port, log } = deps;
	const now = deps.now ?? Date.now;
	const home = deps.home ?? homedir();
	const bindings = new BindingStore(paths.bindings, log, now);
	bindings.load();
	const quarantine = openQuarantineStore(paths.quarantine, log);
	let connected = false;

	const policyFor = (binding: Binding) => {
		try {
			return loadPolicy(binding.repoRoot);
		} catch (err) {
			log(`binding ${binding.key}: policy unreadable (${(err as Error).message}); using the solo defaults`);
			return parsePolicy("");
		}
	};

	const delivery = createDelivery({
		port,
		host,
		quarantine,
		budget: createWakeBudget(),
		now,
		policyFor,
		senderOrgId: createSenderOrgResolver({ host, log, lookup: deps.orgLookup }),
		deferToPlugin: async (binding, paneId) => {
			const agent = await agentOfPane(port, paneId);
			return leaseVerdict(binding.agentId, home, agent?.cwd ?? null, now()).defer;
		},
		log,
	});

	const attachments = createAttachments({
		host,
		source: deps.source,
		now,
		log,
		isAppliedInvite: (binding, inviter) => {
			const live = bindings.forRepo(binding.repoRoot).filter((b) => b.state !== BindingState.Unbound);
			return isAppliedInvite(inviter, binding, policyFor(binding), new Set(live.map((b) => b.agentId)));
		},
		delivery,
		watcher: { watchPane: (id) => feed.watchPane(id), unwatchPane: (id) => feed.unwatchPane(id) },
	});
	const reconciler = createReconciler({ port, bindings, attachments, delivery, log });
	const feed: EventFeed = openEventFeed(port, {
		onEvent: (event) => reconciler.onEvent(event),
		onSnapshot: (agents) =>
			void reconciler.onSnapshot(agents).catch((err: Error) => log(`snapshot reconcile failed: ${err.message}`)),
		onConnection: (up) => {
			connected = up;
			deps.onConnection(up);
		},
		log,
	});

	return {
		handle: createHandler({
			paths,
			host,
			port,
			home,
			now,
			bindings,
			quarantine,
			attachments,
			delivery,
			reconciler,
			facts: () => ({ herdrConnected: connected, unknownFrames: feed.unknownFrames() }),
		}),
		start: () => feed.start(),
		close() {
			feed.stop();
			attachments.close();
			delivery.close();
		},
	};
}
