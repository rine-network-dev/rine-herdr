// reconcile.ts — turns herdr's events and snapshots into attach and detach. A pane is attached while
// herdr shows an agent in it that matches an applied binding by repo and name.
import { type AgentInfo, agentList } from "../herdr/cli.js";
import { HerdrEventKind, type HerdrEvent } from "../herdr/frames.js";
import type { HerdrPort } from "../herdr/port.js";
import type { BindingStore } from "../identity/bindings.js";
import { type Binding, BindingState } from "../types.js";
import type { Attachments } from "./attach.js";
import type { Delivery } from "./delivery.js";
import { agentOfPane, keyOf } from "./registry.js";

export interface Reconciler {
	onEvent(event: HerdrEvent): void;
	onSnapshot(agents: readonly AgentInfo[]): Promise<void>;
	/** Attaches an applied binding to its live pane, if it has one. */
	attachLive(binding: Binding): Promise<void>;
}

export interface ReconcileDeps {
	port: HerdrPort;
	bindings: BindingStore;
	attachments: Attachments;
	delivery: Delivery;
	log(line: string): void;
}

export function createReconciler(deps: ReconcileDeps): Reconciler {
	const { port, bindings, attachments, delivery, log } = deps;

	const bindingFor = async (agent: AgentInfo): Promise<Binding | undefined> => {
		const key = await keyOf(port, agent);
		return bindings.all().find((b) => b.key === key && b.state === BindingState.Applied);
	};

	const tryAttach = async (agent: AgentInfo): Promise<void> => {
		const binding = await bindingFor(agent);
		if (binding !== undefined) attachments.attach(binding, agent.paneId, agent.status);
	};

	const settled = (work: Promise<void>): void =>
		void work.catch((err: Error) => log(`reconcile failed: ${err.message}`));

	return {
		onEvent(event) {
			switch (event.kind) {
				case HerdrEventKind.Status:
					return delivery.onStatus(event.paneId, event.status);
				case HerdrEventKind.PaneClosed:
				case HerdrEventKind.AgentReleased: {
					const key = attachments.keyForPane(event.paneId);
					if (key !== undefined) settled(attachments.detach(key, true));
					return;
				}
				case HerdrEventKind.PaneCreated:
				case HerdrEventKind.AgentDetected:
					return settled(
						agentOfPane(port, event.paneId).then((agent) => (agent === null ? undefined : tryAttach(agent))),
					);
				case HerdrEventKind.EventsLost:
					return;
			}
		},
		async onSnapshot(agents) {
			const live = new Set(agents.map((a) => a.paneId));
			for (const s of attachments.streams()) {
				if (s.paneId !== null && !live.has(s.paneId)) await attachments.detach(s.bindingKey, true);
			}
			for (const agent of agents) {
				if (attachments.keyForPane(agent.paneId) !== undefined) delivery.onStatus(agent.paneId, agent.status);
				else await tryAttach(agent).catch((err: Error) => log(`attach failed: ${err.message}`));
			}
		},
		async attachLive(binding) {
			for (const agent of await agentList(port)) {
				if (agent.name !== binding.herdrName) continue;
				if ((await keyOf(port, agent)) === binding.key) {
					attachments.attach(binding, agent.paneId, agent.status);
					return;
				}
			}
		},
	};
}
