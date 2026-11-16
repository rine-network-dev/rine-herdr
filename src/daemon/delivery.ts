// delivery.ts — when a queued notice becomes a typed envelope. Each bound pane keeps a FIFO and the
// status herdr last reported. A wake happens only on idle or done, within the wake budget, and never
// while the Claude Code plugin delivers for the same agent. A blocked agent is never typed into, and
// agent_blocked is never retried on a timer: the next status change or notice is the only trigger. Any
// other prompt failure retries with a bounded backoff, because an idle agent emits no status event.
import { agentGet, HerdrSound, notify, promptAgent } from "../herdr/cli.js";
import type { HerdrPort } from "../herdr/port.js";
import type { PolicyFile } from "../policy/schema.js";
import { AgentStatus, type Binding, type Host, type InboundNotice, SenderClass } from "../types.js";
import { MAX_PROMPT_RETRIES, newPane, type Pane, retryDelayMs, syncPaneToken } from "./delivery-pane.js";
import { renderEnvelope, safeHandle } from "./envelope.js";
import { classify, Verdict } from "./quarantine.js";
import type { QuarantineStore } from "./quarantine-store.js";
import type { WakeBudget } from "./wake-budget.js";

export const MAX_QUEUED = 200;

export interface DeliveryDeps {
	port: HerdrPort;
	host: Host;
	quarantine: QuarantineStore;
	budget: WakeBudget;
	now(): number;
	policyFor(binding: Binding): PolicyFile;
	/** The sender's org id when it can be resolved; null leaves the org allowlist unmatched. */
	senderOrgId(binding: Binding, notice: InboundNotice): Promise<string | null>;
	/** True while the Claude Code plugin holds a live lease for this agent. */
	deferToPlugin(binding: Binding, paneId: string): Promise<boolean>;
	log(line: string): void;
}

export interface Delivery {
	attach(binding: Binding, paneId: string, status: AgentStatus): void;
	/** `paneGone` skips clearing the pane's token, because the pane no longer exists. */
	detach(bindingKey: string, paneGone: boolean): Promise<void>;
	onStatus(paneId: string, status: AgentStatus): void;
	onNotice(notice: InboundNotice): Promise<void>;
	/** Notices released from quarantine by an approval. */
	release(notices: readonly InboundNotice[]): Promise<void>;
	queued(bindingKey: string): number;
	close(): void;
}

const WAKEABLE: ReadonlySet<AgentStatus> = new Set([AgentStatus.Idle, AgentStatus.Done]);

export function createDelivery(deps: DeliveryDeps): Delivery {
	const byKey = new Map<string, Pane>();
	const byPane = new Map<string, Pane>();

	const syncToken = (pane: Pane): Promise<void> => syncPaneToken(deps.port, deps.log, pane);

	const schedule = (pane: Pane, at: number): void => {
		if (pane.timer !== null) return;
		pane.timer = setTimeout(() => {
			pane.timer = null;
			void tryDeliver(pane);
		}, Math.max(0, at - deps.now()));
	};

	const step = async (pane: Pane): Promise<void> => {
		const { binding, paneId } = pane;
		if (pane.queue.length === 0 || !WAKEABLE.has(pane.status)) return;
		if (await deps.deferToPlugin(binding, paneId)) return;
		const budget = deps.budget.check(binding.key, deps.now());
		if (!budget.allowed) return schedule(pane, budget.nextAllowedAt);
		const batch = pane.queue.splice(0);
		const result = await promptAgent(deps.port, paneId, renderEnvelope(batch, binding.handle));
		if (result.blocked) {
			pane.queue.unshift(...batch);
			pane.status = AgentStatus.Blocked;
			return;
		}
		if (result.error !== null) {
			pane.queue.unshift(...batch);
			pane.failures += 1;
			deps.log(`binding ${binding.key}: prompt failed: ${result.error.code} (attempt ${pane.failures})`);
			if (pane.failures <= MAX_PROMPT_RETRIES) schedule(pane, deps.now() + retryDelayMs(pane.failures));
			return;
		}
		pane.failures = 0;
		deps.budget.record(binding.key, deps.now());
		await syncToken(pane);
	};

	async function tryDeliver(pane: Pane): Promise<void> {
		if (pane.busy) {
			pane.again = true;
			return;
		}
		pane.busy = true;
		try {
			do {
				pane.again = false;
				await step(pane);
			} while (pane.again);
		} catch (err) {
			deps.log(`binding ${pane.binding.key}: delivery failed: ${(err as Error).message}`);
		} finally {
			pane.busy = false;
		}
	}

	const enqueue = async (pane: Pane, notice: InboundNotice, cls: SenderClass): Promise<void> => {
		if (pane.queue.some((q) => q.messageId === notice.messageId)) return;
		pane.queue.push({ ...notice, class: cls });
		if (pane.queue.length > MAX_QUEUED) pane.queue.shift();
		await syncToken(pane);
	};

	/** A blocked status may be stale (a prompt reply said so, the event stream may since have said idle): ask herdr. */
	const refreshBlocked = async (pane: Pane): Promise<void> => {
		if (pane.status !== AgentStatus.Blocked) return;
		try {
			pane.status = (await agentGet(deps.port, pane.paneId)).status;
		} catch (err) {
			deps.log(`binding ${pane.binding.key}: status read failed: ${(err as Error).message}`);
		}
	};

	const hold = async (pane: Pane, notice: InboundNotice): Promise<void> => {
		if (!deps.quarantine.hold(notice)) return;
		const sender = safeHandle(notice.senderHandle) ?? "an unrecognised sender";
		try {
			await notify(deps.port, {
				title: `rine: first contact for ${pane.binding.handle}`,
				body: `from ${sender}. Approve or deny in the rine pane.`,
				sound: HerdrSound.Request,
			});
		} catch (err) {
			deps.log(`binding ${pane.binding.key}: toast failed: ${(err as Error).message}`);
		}
	};

	return {
		attach(binding, paneId, status) {
			const pane = byKey.get(binding.key) ?? newPane(binding, paneId, status);
			byPane.delete(pane.paneId);
			Object.assign(pane, { binding, paneId, status });
			byKey.set(binding.key, pane);
			byPane.set(paneId, pane);
			void tryDeliver(pane);
		},
		async detach(bindingKey, paneGone) {
			const pane = byKey.get(bindingKey);
			if (pane === undefined) return;
			if (pane.timer !== null) clearTimeout(pane.timer);
			byKey.delete(bindingKey);
			byPane.delete(pane.paneId);
			pane.queue = [];
			if (!paneGone) {
				pane.tokenCount = -1;
				await syncToken(pane);
			}
		},
		onStatus(paneId, status) {
			const pane = byPane.get(paneId);
			if (pane === undefined) return;
			pane.status = status;
			pane.failures = 0;
			void tryDeliver(pane);
		},
		async onNotice(notice) {
			const pane = byKey.get(notice.bindingKey);
			if (pane === undefined) return;
			const { quarantine } = deps;
			if (quarantine.isDenied(notice.bindingKey, notice.senderId)) return;
			const policy = deps.policyFor(pane.binding);
			const senderOrgId = policy.externalOrgs.length > 0 ? await deps.senderOrgId(pane.binding, notice) : null;
			const facts = { approved: quarantine.approvedSenders(notice.bindingKey), senderOrgId };
			const verdict = classify(notice, policy, deps.host, facts);
			if (verdict.verdict === Verdict.Drop) return;
			if (verdict.verdict === Verdict.Hold) return hold(pane, notice);
			if (verdict.recordApproval) quarantine.approve(notice.bindingKey, notice.senderId);
			await enqueue(pane, notice, verdict.class);
			await refreshBlocked(pane);
			await tryDeliver(pane);
		},
		async release(notices) {
			const touched = new Set<Pane>();
			for (const notice of notices) {
				const pane = byKey.get(notice.bindingKey);
				if (pane === undefined) continue;
				await enqueue(pane, notice, SenderClass.ExternalApproved);
				touched.add(pane);
			}
			for (const pane of touched) {
				await refreshBlocked(pane);
				await tryDeliver(pane);
			}
		},
		queued: (key) => byKey.get(key)?.queue.length ?? 0,
		close() {
			for (const pane of byKey.values()) if (pane.timer !== null) clearTimeout(pane.timer);
			byKey.clear();
			byPane.clear();
		},
	};
}
