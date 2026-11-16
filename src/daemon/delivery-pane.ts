// delivery-pane.ts — the per-pane state delivery.ts keeps: the FIFO, the last status, the retry count and
// the herdr token that mirrors the queue length.
import { clearToken, reportToken } from "../herdr/cli.js";
import type { HerdrPort } from "../herdr/port.js";
import type { AgentStatus, Binding } from "../types.js";
import type { Announced } from "./envelope.js";

/** Consecutive failed prompts before the daemon stops retrying and waits for a status change. */
export const MAX_PROMPT_RETRIES = 5;
const RETRY_BASE_MS = 2_000;

export interface Pane {
	binding: Binding;
	paneId: string;
	status: AgentStatus;
	queue: Announced[];
	timer: ReturnType<typeof setTimeout> | null;
	busy: boolean;
	again: boolean;
	tokenCount: number;
	/** Consecutive prompt failures that were not a blocked agent. */
	failures: number;
}

export const newPane = (binding: Binding, paneId: string, status: AgentStatus): Pane => ({
	binding, paneId, status, queue: [], timer: null, busy: false, again: false, tokenCount: 0, failures: 0,
});

/** Exponential: 2 s, 4 s, 8 s, 16 s, 32 s. */
export const retryDelayMs = (failures: number): number => RETRY_BASE_MS * 2 ** (failures - 1);

export async function syncPaneToken(port: HerdrPort, log: (line: string) => void, pane: Pane): Promise<void> {
	const count = pane.queue.length;
	if (count === pane.tokenCount) return;
	pane.tokenCount = count;
	try {
		if (count > 0) await reportToken(port, pane.paneId, `${count} queued`);
		else await clearToken(port, pane.paneId);
	} catch (err) {
		log(`binding ${pane.binding.key}: token update failed: ${(err as Error).message}`);
	}
}
