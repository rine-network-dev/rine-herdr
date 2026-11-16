// unseated.ts — which invitees an MLS admission left without a leaf. During apply that is the normal case: an
// invitee joins in a later step and takes its own leaf, so the SDK's notice is held back and only whoever is still
// unseated when the plan ends is reported.
import type { MlsAdmissionResult } from "@rine-network/sdk";

export interface UnseatedTracker {
	/** The SDK's `onMlsUnseated` hook. */
	record(groupId: string, result: MlsAdmissionResult): void;
	/** The agent joined the group, which seats it. */
	seated(groupId: string, agentId: string): void;
	/** Group id to the agent ids still unseated. */
	remaining(): ReadonlyMap<string, ReadonlySet<string>>;
}

export function unseatedTracker(): UnseatedTracker {
	const open = new Map<string, Set<string>>();
	return {
		record(groupId, result) {
			const skipped = result.outcomes.filter((o) => o.status === "skipped" && o.reason !== "already_in_group");
			if (skipped.length > 0) open.set(groupId, new Set([...(open.get(groupId) ?? []), ...skipped.map((o) => o.agentId)]));
		},
		seated(groupId, agentId) {
			open.get(groupId)?.delete(agentId);
		},
		remaining: () => new Map([...open].filter(([, agents]) => agents.size > 0)),
	};
}
