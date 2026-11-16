// handlers.ts — the eight IPC methods. Each takes the validated request params and returns the result
// the method's schema in ipc-schemas.ts describes; a thrown Error becomes the reply's `error`.
import { agentRename } from "../herdr/cli.js";
import type { HerdrPort } from "../herdr/port.js";
import type { BindingStore } from "../identity/bindings.js";
import { bindingKey, type StatePaths } from "../identity/paths.js";
import { provisionBinding } from "../identity/provision.js";
import { loadPolicy } from "../policy/schema.js";
import { HERDR_DEFAULT_TOOLS, HERDR_OPTIONAL_TOOLS, isExposableTool } from "../tool-profiles.js";
import { type Binding, BindingState, type Host, type IpcRequest, IpcMethod, QuarantineDecision } from "../types.js";
import type { Attachments } from "./attach.js";
import { leaseVerdict } from "./cc-lease.js";
import type { Delivery } from "./delivery.js";
import type { QuarantineStore } from "./quarantine-store.js";
import type { Reconciler } from "./reconcile.js";
import { agentOfPane, keyOf, refOf } from "./registry.js";

export interface HandlerDeps {
	paths: StatePaths;
	host: Host;
	port: HerdrPort;
	home: string;
	now(): number;
	bindings: BindingStore;
	quarantine: QuarantineStore;
	attachments: Attachments;
	delivery: Delivery;
	reconciler: Reconciler;
	/** Daemon-level facts the `status` method reports. */
	facts(): { herdrConnected: boolean; unknownFrames: number };
}

export function leaseWarning(agentId: string): string {
	return `this Claude Code session already carries rine identity ${agentId} through the rine plugin; binding adds a second identity`;
}

export function createHandler(deps: HandlerDeps): (request: IpcRequest) => Promise<unknown> {
	const { bindings, port } = deps;

	const bindingOfPane = async (paneId: string): Promise<Binding | null> => {
		const agent = await agentOfPane(port, paneId);
		const key = agent === null ? null : await keyOf(port, agent);
		return bindings.all().find((b) => b.key === key) ?? null;
	};

	const bind = async (paneId: string, name: string | undefined): Promise<unknown> => {
		let agent = await agentOfPane(port, paneId);
		if (agent === null) throw new Error(`pane ${paneId} runs no agent herdr knows`);
		if (name !== undefined && agent.name !== name) agent = await agentRename(port, paneId, name);
		const ref = await refOf(port, agent);
		if (ref === null) throw new Error(`pane ${paneId} has no herdr agent name or sits outside a git repository`);
		const existing = bindings.all().find((b) => b.key === bindingKey(ref.repoRoot, ref.herdrName));
		const binding =
			existing && existing.state !== BindingState.Unbound
				? existing
				: existing
					? { ...existing, state: BindingState.PendingApply, appliedAt: null }
					: await provisionBinding(deps.paths, deps.host, ref, loadPolicy(ref.repoRoot));
		if (binding !== existing) bindings.upsert(binding);
		const { foreignAgentId } = leaseVerdict(binding.agentId, deps.home, agent.cwd, deps.now());
		return { binding, warnings: foreignAgentId === null ? [] : [leaseWarning(foreignAgentId)] };
	};

	const markApplied = async (keys: readonly string[], tools: Readonly<Record<string, readonly string[]>>): Promise<unknown> => {
		const exposable: ReadonlySet<string> = new Set([...HERDR_DEFAULT_TOOLS, ...HERDR_OPTIONAL_TOOLS]);
		const refused = Object.values(tools).flat().filter((name) => !exposable.has(name));
		if (refused.length > 0) throw new Error(`tools not available to herdr panes: ${[...new Set(refused)].join(", ")}`);
		const updated: string[] = [];
		for (const key of keys) {
			const current = bindings.all().find((b) => b.key === key);
			if (current === undefined) continue;
			const next: Binding = {
				...current,
				state: BindingState.Applied,
				appliedAt: new Date(deps.now()).toISOString(),
				tools: (tools[key] ?? current.tools).filter(isExposableTool),
			};
			bindings.upsert(next);
			updated.push(key);
			await deps.reconciler.attachLive(next);
		}
		return { updated };
	};

	return async (request) => {
		switch (request.method) {
			case IpcMethod.Status:
				return {
					pid: process.pid,
					...deps.facts(),
					droppedFrames: deps.attachments.dropped(),
					held: deps.quarantine.contacts(),
					streams: deps.attachments.streams(),
				};
			case IpcMethod.ForPane:
				return { binding: await bindingOfPane(request.params.paneId) };
			case IpcMethod.Snapshot:
				return {
					bindings: request.params.repoRoot === undefined ? bindings.all() : bindings.forRepo(request.params.repoRoot),
				};
			case IpcMethod.Bind:
				return bind(request.params.paneId, request.params.name);
			case IpcMethod.Unbind: {
				const binding = await bindingOfPane(request.params.paneId);
				if (binding === null) return { binding: null };
				const unbound = { ...binding, state: BindingState.Unbound };
				bindings.upsert(unbound);
				await deps.attachments.detach(binding.key, false);
				return { binding: unbound };
			}
			case IpcMethod.MarkApplied:
				return markApplied(request.params.keys, request.params.tools);
			case IpcMethod.QuarantineList:
				return { entries: deps.quarantine.list() };
			case IpcMethod.QuarantineDecide: {
				const { bindingKey: key, senderId, decision } = request.params;
				const settled = deps.quarantine.decide(key, senderId, decision);
				if (decision === QuarantineDecision.Approve) await deps.delivery.release(settled);
				return { settled: settled.length };
			}
		}
	};
}
