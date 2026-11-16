// port.ts — an in-memory BindingsPort, so apply tests need no daemon.
import type { BindingsPort } from "../../src/identity/observe.js";
import { isExposableTool } from "../../src/tool-profiles.js";
import { type Binding, BindingState } from "../../src/types.js";

/** A `BindingsPort` over a fixed binding list that records what `markApplied` receives. */
export function fakePort(bindings: readonly Binding[]): BindingsPort & { applied: { keys: readonly string[]; tools: Record<string, readonly string[]> }[] } {
	const applied: { keys: readonly string[]; tools: Record<string, readonly string[]> }[] = [];
	let current = [...bindings];
	return {
		applied,
		snapshot: async (repoRoot) => current.filter((b) => b.repoRoot === repoRoot),
		markApplied: async (keys, tools) => {
			applied.push({ keys, tools: { ...tools } });
			current = current.map((b) => (keys.includes(b.key) ? { ...b, state: BindingState.Applied, tools: (tools[b.key] ?? []).filter(isExposableTool) } : b));
		},
	};
}
