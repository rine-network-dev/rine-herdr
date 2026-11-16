// ipc-schemas.ts — the result of every daemon IPC method. The server checks what a handler returns and the
// client checks what it receives, so neither side trusts `unknown`. Requests live in types.ts.
import { z } from "zod";
import { BindingSchema, IpcMethod } from "../types.js";
import { StreamState } from "./inbound.js";
import { NoticeSchema } from "./quarantine-store.js";

export const StatusResult = z.object({
	pid: z.number().int(),
	herdrConnected: z.boolean(),
	unknownFrames: z.number().int(),
	droppedFrames: z.number().int(),
	held: z.number().int(),
	streams: z.array(z.object({ bindingKey: z.string(), herdrName: z.string(), paneId: z.string().nullable(), state: z.enum(StreamState) })),
});

export const ForPaneResult = z.object({ binding: BindingSchema.nullable() });
export const SnapshotResult = z.object({ bindings: z.array(BindingSchema) });
export const BindResult = z.object({ binding: BindingSchema, warnings: z.array(z.string()) });
export const UnbindResult = z.object({ binding: BindingSchema.nullable() });
export const MarkAppliedResult = z.object({ updated: z.array(z.string()) });
export const QuarantineListResult = z.object({ entries: z.array(NoticeSchema) });
export const QuarantineDecideResult = z.object({ settled: z.number().int() });

export const IpcResults = {
	[IpcMethod.Status]: StatusResult,
	[IpcMethod.ForPane]: ForPaneResult,
	[IpcMethod.Snapshot]: SnapshotResult,
	[IpcMethod.Bind]: BindResult,
	[IpcMethod.Unbind]: UnbindResult,
	[IpcMethod.MarkApplied]: MarkAppliedResult,
	[IpcMethod.QuarantineList]: QuarantineListResult,
	[IpcMethod.QuarantineDecide]: QuarantineDecideResult,
} as const satisfies Record<IpcMethod, z.ZodType>;

export const IpcReplyWire = z.union([
	z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown().optional() }),
	z.object({ id: z.number().int(), ok: z.literal(false), error: z.string() }),
]);
