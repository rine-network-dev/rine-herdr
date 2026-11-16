// sender-org.ts — the org a sender belongs to, for the policy's [external].orgs allowlist. The answer is the
// chain-verified org id of the sender's published keys; core's key cache makes a repeat lookup free. A lookup
// that fails answers null, which leaves the sender unmatched: first contact, never a silent allow.
import { fetchAgentKeys, type HttpClient } from "@rine-network/core";
import { coreHttp } from "../identity/clients.js";
import type { Binding, Host, InboundNotice } from "../types.js";

/** Reads a sender's org id; the real one signs as the pane agent and chain-verifies the keys. */
export type OrgLookup = (binding: Binding, senderId: string) => Promise<string>;

export interface SenderOrgDeps {
	host: Host;
	log(line: string): void;
	lookup?: OrgLookup;
}

function keysLookup(host: Host): OrgLookup {
	const clients = new Map<string, HttpClient>();
	return async (binding, senderId) => {
		const client = clients.get(binding.key) ?? coreHttp({ configDir: binding.configDir, agentOnly: true }, host.apiUrl);
		clients.set(binding.key, client);
		return (await fetchAgentKeys(client, senderId)).keys.orgId;
	};
}

export function createSenderOrgResolver(deps: SenderOrgDeps): (binding: Binding, notice: InboundNotice) => Promise<string | null> {
	const lookup = deps.lookup ?? keysLookup(deps.host);
	return async (binding, notice) => {
		try {
			return await lookup(binding, notice.senderId);
		} catch (err) {
			deps.log(`binding ${binding.key}: sender org lookup failed: ${(err as Error).message}`);
			return null;
		}
	};
}
