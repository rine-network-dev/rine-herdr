// daemon-client.ts — the typed client of the daemon's IPC socket, shared by the shim, the CLI and the pane.
// It also is the `BindingsPort` that `plan` and `apply` use to reach the daemon-owned bindings.
import type { z } from "zod";
import { ipcCall } from "../daemon/ipc.js";
import {
	BindResult,
	ForPaneResult,
	MarkAppliedResult,
	QuarantineDecideResult,
	QuarantineListResult,
	SnapshotResult,
	StatusResult,
	UnbindResult,
} from "../daemon/ipc-schemas.js";
import type { BindingsPort } from "../identity/observe.js";
import { type Binding, IpcMethod, type QuarantineDecision } from "../types.js";

export interface DaemonClient extends BindingsPort {
	status(): Promise<z.infer<typeof StatusResult>>;
	forPane(paneId: string): Promise<Binding | null>;
	bind(paneId: string, name?: string): Promise<z.infer<typeof BindResult>>;
	unbind(paneId: string): Promise<Binding | null>;
	quarantineList(): Promise<z.infer<typeof QuarantineListResult>["entries"]>;
	quarantineDecide(bindingKey: string, senderId: string, decision: QuarantineDecision): Promise<number>;
}

export function daemonClient(socketPath: string): DaemonClient {
	return {
		status: () => ipcCall(socketPath, IpcMethod.Status, {}, StatusResult),
		forPane: async (paneId) => (await ipcCall(socketPath, IpcMethod.ForPane, { paneId }, ForPaneResult)).binding,
		snapshot: async (repoRoot) => (await ipcCall(socketPath, IpcMethod.Snapshot, { repoRoot }, SnapshotResult)).bindings,
		bind: (paneId, name) => ipcCall(socketPath, IpcMethod.Bind, { paneId, name }, BindResult),
		unbind: async (paneId) => (await ipcCall(socketPath, IpcMethod.Unbind, { paneId }, UnbindResult)).binding,
		markApplied: async (keys, tools) => {
			await ipcCall(
				socketPath,
				IpcMethod.MarkApplied,
				{ keys: [...keys], tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, [...v]])) },
				MarkAppliedResult,
			);
		},
		quarantineList: async () => (await ipcCall(socketPath, IpcMethod.QuarantineList, {}, QuarantineListResult)).entries,
		quarantineDecide: async (bindingKey, senderId, decision) =>
			(await ipcCall(socketPath, IpcMethod.QuarantineDecide, { bindingKey, senderId, decision }, QuarantineDecideResult)).settled,
	};
}
