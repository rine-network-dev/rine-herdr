// fixtures.ts — a binding to hand the shim, in any state.
import { type Binding, BindingState } from "../../src/types.js";

export function binding(state: Binding["state"], tools: Binding["tools"] = [], configDir = "/state/agents/0123456789abcdef"): Binding {
	return {
		key: "0123456789abcdef",
		repoRoot: "/work/repo",
		herdrName: "lead",
		agentId: "7c1e5b0a-0000-4000-8000-000000000001",
		handle: "repo-lead@acme.rine.network",
		configDir,
		state,
		tools,
		createdAt: "2026-11-13T10:00:00.000Z",
		appliedAt: state === BindingState.Applied ? "2026-11-13T10:05:00.000Z" : null,
	};
}
