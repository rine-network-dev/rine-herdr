// quarantine.ts — which inbound messages wake an agent. It controls attention only: a held message is
// still listed by rine_inbox, and server-side consent is a separate founder decision.
import { GROUP_PREFIX } from "../policy/plan.js";
import type { PolicyFile } from "../policy/schema.js";
import { type Binding, FirstContact, type Host, type InboundNotice, Profile, SenderClass } from "../types.js";

export const Verdict = { Announce: "announce", Hold: "hold", Drop: "drop" } as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface Classification {
	verdict: Verdict;
	class: SenderClass;
	/** First contact allowed by policy: the caller records the sender as approved. */
	recordApproval: boolean;
}

export interface SenderFacts {
	/** Senders already approved for this binding. */
	approved: ReadonlySet<string>;
	/** The sender's org id when the daemon could resolve it; null otherwise. */
	senderOrgId: string | null;
}

const bareGroup = (handle: string): string => handle.replace(/^#/, "").toLowerCase();
const groupName = (handle: string): string => bareGroup(handle).split("@")[0] ?? "";

function inKnownGroup(groupHandle: string, policy: PolicyFile): boolean {
	if (groupName(groupHandle).startsWith(GROUP_PREFIX)) return true;
	return policy.externalGroups.some((g) => bareGroup(g.handle) === bareGroup(groupHandle));
}

const handleDomain = (handle: string | null): string | null => handle?.split("@")[1]?.toLowerCase() ?? null;

/**
 * Whether a `rine.v1.group_invite` frame looks like an invitation that `apply` already answered, so it wakes nobody
 * and is never held. The frame is a sealed 1:1 message: it names the inviter and the invitee, but the group is inside
 * the ciphertext, which the daemon never opens. So the rule goes by who invited whom, from cleartext fields only:
 * - the inviter is another agent bound in this repo (`branchAgentIds`, unbound ones left out), the way `apply` seats
 *   the herdr-* groups; or
 * - the inviter sits on the domain of a configured `[[external.groups]]` handle that names this agent.
 * The solo profile creates no groups, so nothing is an applied invite there. This is an over-approximation: an
 * invite to some other group from those inviters is dropped too (`rine_group_invites` still lists it). An invite
 * from anyone else is judged like any other first message.
 */
export function isAppliedInvite(
	inviter: { id: string; handle: string | null },
	binding: Binding,
	policy: PolicyFile,
	branchAgentIds: ReadonlySet<string>,
): boolean {
	if (policy.profile === Profile.Solo) return false;
	if (branchAgentIds.has(inviter.id)) return true;
	const domain = handleDomain(inviter.handle);
	return domain !== null && policy.externalGroups.some((g) => g.agents.includes(binding.herdrName) && handleDomain(g.handle) === domain);
}

export function classify(
	notice: InboundNotice,
	policy: PolicyFile,
	host: Host,
	facts: SenderFacts,
): Classification {
	const announce = (cls: SenderClass, recordApproval = false): Classification => ({ verdict: Verdict.Announce, class: cls, recordApproval });
	if (notice.senderOrgSlug !== null && notice.senderOrgSlug === host.orgSlug) return announce(SenderClass.SameOrg);
	if (notice.groupHandle !== null && inKnownGroup(notice.groupHandle, policy)) return announce(SenderClass.Group);
	if (facts.senderOrgId !== null && policy.externalOrgs.includes(facts.senderOrgId)) {
		return announce(SenderClass.ExternalAllowlisted);
	}
	if (facts.approved.has(notice.senderId)) return announce(SenderClass.ExternalApproved);
	switch (policy.firstContact) {
		case FirstContact.Allow:
			return announce(SenderClass.ExternalApproved, true);
		case FirstContact.Deny:
			return { verdict: Verdict.Drop, class: SenderClass.ExternalApproved, recordApproval: false };
		case FirstContact.Approve:
			return { verdict: Verdict.Hold, class: SenderClass.ExternalApproved, recordApproval: false };
	}
}
