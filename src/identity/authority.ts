// authority.ts — which principal `apply` acts as. The host branch is the default; the org owner is loaded only where
// the branch cannot act: allow entries (they widen the org's external ceiling) and, while the org stops new agents,
// loosening an agent's policy.
import { RuleDirection, RuleMode, type HttpClient } from "@rine-network/core";
import { z } from "zod";
import type { ObservedAgent } from "../policy/plan.js";
import type { DesiredAgentPolicy, Host } from "../types.js";
import { Profile } from "../types.js";

const mode = z.enum([RuleMode.Off, RuleMode.Report, RuleMode.Enforce]);
// The SDK's whoami drops `rules`, so the branch's own `/whoami` is read raw and checked here. The server answers one mode per rule.
const WhoAmIRules = z.object({
	principal: z.object({ kind: z.string() }),
	rules: z.object({ external_inbound: mode, external_outbound: mode, new_agents: mode }),
});

export interface RuleModes {
	external_inbound: RuleMode;
	external_outbound: RuleMode;
	new_agents: RuleMode;
}

/** The org's rule modes, read as the branch. Refuses an answer that does not speak for a branch. */
export async function readRuleModes(http: HttpClient): Promise<RuleModes> {
	const who = WhoAmIRules.parse(await http.get("/whoami"));
	if (who.principal.kind !== "branch") throw new Error(`the host identity resolves as ${who.principal.kind}, not as a branch`);
	return {
		external_inbound: who.rules.external_inbound,
		external_outbound: who.rules.external_outbound,
		new_agents: who.rules.new_agents,
	};
}

/** Directions whose rule is at `enforce`. */
export function enforcedDirections(modes: RuleModes): RuleDirection[] {
	return [
		...(modes.external_outbound === RuleMode.Enforce ? [RuleDirection.Outbound] : []),
		...(modes.external_inbound === RuleMode.Enforce ? [RuleDirection.Inbound] : []),
	];
}

export interface OwnerNeed {
	/** The owner writes allow entries; the branch keeps every other step. */
	allow: boolean;
	/** The owner acts for the policy steps too, because the branch may not loosen. */
	loosening: boolean;
}

/** What in this plan the branch cannot do. `seen` is the server's view of each live agent, by agent id. */
export function ownerNeed(
	profile: Profile,
	externalOrgs: readonly string[],
	modes: RuleModes,
	want: Pick<DesiredAgentPolicy, "incoming" | "outgoing">,
	seen: readonly Pick<ObservedAgent, "incoming" | "outgoing">[],
): OwnerNeed {
	const allow = profile !== Profile.Solo && externalOrgs.length > 0 && enforcedDirections(modes).length > 0;
	const loosening =
		modes.new_agents === RuleMode.Enforce &&
		seen.some((s) => (want.incoming === "accept_all" && s.incoming === "groups_only") || (want.outgoing === "send_all" && s.outgoing === "groups_only"));
	return { allow, loosening };
}

/** The one line `plan` and `apply` print to name who acts. */
export function authorityLine(host: Host, need: OwnerNeed): string {
	if (need.loosening) return "authority: org owner (the org stops new agents, so only the org loosens an agent's policy)";
	if (need.allow) return `authority: branch ${host.branch}; org owner for allow entries (the org enforces external message rules)`;
	return `authority: branch ${host.branch} (no owner directory needed)`;
}
