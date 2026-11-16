// harness.ts — a fake rine server behind the global `fetch`, so the identity tests drive the real core and SDK clients.
// Only the network is faked: key derivation, request signing, schema parsing and path literals are the shipped code.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ORG_ID, seedOrgIdentity } from "@rine-network/core/testing";
import { vi } from "vitest";
import { type StatePaths, statePaths } from "../../src/identity/paths.js";

export const API = "https://api.test.rine";
export const ORG_ID = FIXTURE_ORG_ID;
export const NOW = "2026-11-13T10:00:00.000Z";

export interface Call {
	method: string;
	path: string;
	body: Record<string, unknown>;
	/** The principal string the request was signed as: `org:<id>`, `branch:<org>:<name>`, `agent:<id>`. */
	caller: string;
}

interface FakeAgent {
	id: string;
	name: string;
	handle: string;
	incoming_policy: string;
	outgoing_policy: string;
	preset: string;
}

/** The `sub` of the signed client assertion in a token request: the principal string the caller signs as. */
function principalOf(form: string): string {
	const assertion = new URLSearchParams(form).get("client_assertion") ?? "";
	const payload = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub: string };
	return payload.sub;
}

function principalView(principal: string): { kind: string; agent_id?: string } {
	const [kind = "org", id] = principal.split(":");
	return kind === "agent" ? { kind, agent_id: id } : { kind };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The routes rine-herdr touches, with just enough state to answer reads after writes. */
export class FakeRine {
	readonly calls: Call[] = [];
	readonly agents = new Map<string, FakeAgent>();
	readonly groups: { id: string; name: string; handle: string; members: Set<string>; admins?: Set<string> }[] = [];
	branches = new Set<string>();
	readonly allow: Record<string, unknown>[] = [];
	/** `"METHOD /path"` to a status that replaces the normal answer. */
	refuse = new Map<string, number>();
	groupLimit: number | null = 100;
	/** A refusal only a branch key meets: `"METHOD /path"` to the status and body an older or stricter server answers. */
	refuseBranch = new Map<string, { status: number; detail: string; error?: string }>();
	/** The org's rule modes, as `/whoami` and `/org/policy` report them. */
	modes: Record<"external_inbound" | "external_outbound" | "new_agents", string> = { external_inbound: "enforce", external_outbound: "enforce", new_agents: "off" };

	readonly fetch = async (input: unknown, init?: { method?: string; body?: unknown; headers?: ConstructorParameters<typeof Headers>[0] }): Promise<Response> => {
		const path = String(input).slice(API.length);
		const method = (init?.method ?? "GET").toUpperCase();
		const text = typeof init?.body === "string" ? init.body : "{}";
		if (path === "/oauth/token") return json({ access_token: principalOf(text), expires_in: 900 });
		const body = JSON.parse(text) as Record<string, unknown>;
		const caller = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
		this.calls.push({ method, path, body, caller });
		const status = this.refuse.get(`${method} ${path}`);
		if (status !== undefined) return json({ detail: `refused ${status}` }, status);
		const branchRefusal = caller.startsWith("branch:") ? this.refuseBranch.get(`${method} ${path}`) : undefined;
		if (branchRefusal) return json({ detail: branchRefusal.detail, error: branchRefusal.error }, branchRefusal.status);
		return this.route(method, path, body, caller);
	};

	private route(method: string, path: string, body: Record<string, unknown>, caller: string): Response {
		const key = `${method} ${path.split("?")[0]}`;
		const agentPath = /^\/agents\/([0-9a-f-]{36})(\/exposure)?$/.exec(path);
		const joinPath = /^\/groups\/([0-9a-f-]{36})\/join$/.exec(path);
		if (key === "POST /orgs/me/branches") {
			const name = String(body["name"]);
			if (this.branches.has(name)) return json({ detail: "branch exists" }, 409);
			this.branches.add(name);
			return json({}, 201);
		}
		if (key === "GET /whoami") return json({ org: this.org(), principal: principalView(caller), rules: this.whoamiRules(), agents: [...this.agents.values()].map((a) => this.agentRow(a)) });
		if (key === "POST /agents") return this.createAgent(body);
		if (key === "GET /agents") return json({ items: [...this.agents.values()].map((a) => this.agentRow(a)) });
		if (agentPath && method === "PATCH") return this.patchAgent(agentPath[1] ?? "", body);
		if (agentPath?.[2] && method === "PUT") return this.putExposure(agentPath[1] ?? "", body);
		if (agentPath?.[2] && method === "GET") return this.exposureView(agentPath[1] ?? "");
		if (key === "GET /org/quotas") return json({ tier: 1, quotas: { max_groups: { limit: this.groupLimit, used: this.groups.length } } });
		if (key === "GET /org/policy") return json(this.policyView());
		if (key === "PUT /org/allow") return this.putAllow(body);
		if (key === "GET /org/allow") return json({ entries: this.allow, next_cursor: null });
		if (key === "GET /groups") return json({ items: this.groups.map((g) => this.groupRow(g)) });
		if (key === "GET /groups/invites") return json({ items: [] });
		if (key === "POST /groups") return this.createGroup(body);
		if (joinPath) return this.joinGroup(joinPath[1] ?? "");
		const groupPath = /^\/groups\/([0-9a-f-]{36})$/.exec(path);
		if (groupPath && method === "DELETE") return this.deleteGroup(groupPath[1] ?? "");
		const rosterPath = /^\/groups\/([0-9a-f-]{36})\/members$/.exec(path);
		if (rosterPath && method === "GET") return this.roster(rosterPath[1] ?? "");
		const seatPath = /^\/groups\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/.exec(path);
		if (seatPath && method === "DELETE") return this.removeMember(seatPath[1] ?? "", seatPath[2] ?? "");
		return json({ detail: `fake rine: no route for ${key}` }, 404);
	}

	private org() {
		return { id: ORG_ID, name: "Acme", slug: "acme", trust_tier: 1, agent_count: this.agents.size, created_at: NOW };
	}

	/** An `AgentRead` row. Like the real one it carries no `preset`: that is read from `/agents/{id}/exposure`. */
	private agentRow({ preset: _preset, ...a }: FakeAgent) {
		return { ...a, human_oversight: false, created_at: NOW };
	}

	private createAgent(body: Record<string, unknown>): Response {
		const name = String(body["name"]);
		if ([...this.agents.values()].some((a) => a.name === name)) return json({ detail: "agent name taken" }, 409);
		const id = String(body["id"]);
		const agent = { id, name, handle: `${name}@acme.rine.network`, incoming_policy: "accept_all", outgoing_policy: "send_all", preset: "findable" };
		this.agents.set(id, agent);
		return json(this.agentRow(agent), 201);
	}

	private patchAgent(id: string, body: Record<string, unknown>): Response {
		const agent = this.agents.get(id);
		if (!agent) return json({ detail: "no such agent" }, 404);
		if (typeof body["incoming_policy"] === "string") agent.incoming_policy = body["incoming_policy"];
		if (typeof body["outgoing_policy"] === "string") agent.outgoing_policy = body["outgoing_policy"];
		return json(this.agentRow(agent));
	}

	private putExposure(id: string, body: Record<string, unknown>): Response {
		const agent = this.agents.get(id);
		if (!agent) return json({ detail: "no such agent" }, 404);
		agent.preset = String(body["exposure"]);
		return this.exposureView(id);
	}

	private exposureView(id: string): Response {
		const agent = this.agents.get(id);
		if (!agent) return json({ detail: "no such agent" }, 404);
		return json({ exposure: {}, preset: agent.preset, a2a_available: false, always_on: [], ceiling: null, above_ceiling: [] });
	}

	private putAllow(body: Record<string, unknown>): Response {
		const entry = { id: crypto.randomUUID(), scope_agent_id: body["agent_id"], direction: body["direction"], counterparty_org_id: body["counterparty_org_id"], decision: body["decision"] };
		this.allow.push(entry);
		return json(entry);
	}

	/** The server's `RuleModesView`: one mode string per rule. */
	private whoamiRules() {
		return { ...this.modes };
	}

	private policyView() {
		const rule = (mode: string) => ({ mode, allow_count: 0 });
		return {
			version: 1,
			updated_at: null,
			groups_covered: false,
			existing: {},
			rules: { external_inbound: rule(this.modes.external_inbound), external_outbound: rule(this.modes.external_outbound) },
		};
	}

	private groupRow(g: { id: string; name: string; handle: string; members: Set<string> }) {
		return { id: g.id, name: g.name, handle: g.handle, enrollment_policy: "closed", visibility: "private", member_count: g.members.size, created_at: NOW };
	}

	private createGroup(body: Record<string, unknown>): Response {
		const group = { id: crypto.randomUUID(), name: String(body["name"]), handle: `#${String(body["name"])}@acme`, members: new Set<string>() };
		this.groups.push(group);
		return json(this.groupRow(group), 201);
	}

	private deleteGroup(groupId: string): Response {
		const at = this.groups.findIndex((g) => g.id === groupId);
		if (at < 0) return json({ detail: "no such group" }, 404);
		this.groups.splice(at, 1);
		return new Response(null, { status: 204 });
	}

	private roster(groupId: string): Response {
		const group = this.groups.find((g) => g.id === groupId);
		if (!group) return json({ detail: "no such group" }, 404);
		const items = [...group.members].map((agentId) => ({ id: crypto.randomUUID(), group_id: groupId, agent_id: agentId, role: group.admins?.has(agentId) ? "admin" : "member", joined_at: NOW }));
		return json({ items, total: items.length, next_cursor: null });
	}

	/** The server's rule: the last admin cannot be removed. */
	private removeMember(groupId: string, agentId: string): Response {
		const group = this.groups.find((g) => g.id === groupId);
		if (!group?.members.has(agentId)) return json({ detail: "Member not found" }, 404);
		if (group.admins?.has(agentId) && group.admins.size <= 1) return json({ detail: "Cannot remove the last admin from the group" }, 422);
		group.members.delete(agentId);
		group.admins?.delete(agentId);
		return new Response(null, { status: 204 });
	}

	private joinGroup(groupId: string): Response {
		const group = this.groups.find((g) => g.id === groupId);
		if (!group) return json({ detail: "no such group" }, 404);
		return json({ id: crypto.randomUUID(), group_id: groupId, agent_id: crypto.randomUUID(), joined_at: NOW });
	}

	callsTo(method: string, pattern: RegExp): Call[] {
		return this.calls.filter((c) => c.method === method && pattern.test(c.path));
	}
}

export interface Rig {
	fake: FakeRine;
	/** The state dir of a rine-herdr host, and the owner dir holding the fixture org's root. */
	paths: StatePaths;
	stateDir: string;
	ownerDir: string;
	cleanup(): void;
}

/** A temp state dir, an owner dir with the fixture org, and the fake server on the global `fetch`. */
export function makeRig(): Rig {
	const base = mkdtempSync(join(tmpdir(), "rine-herdr-test-"));
	const stateDir = join(base, "state");
	const ownerDir = join(base, "owner");
	seedOrgIdentity(ownerDir);
	const fake = new FakeRine();
	vi.stubGlobal("fetch", fake.fetch);
	vi.stubEnv("RINE_OWNER_DIR", ownerDir);
	return {
		fake,
		paths: statePaths(stateDir),
		stateDir,
		ownerDir,
		cleanup: () => {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		},
	};
}
