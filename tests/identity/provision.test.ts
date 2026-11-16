import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILE, getProfile } from "@rine-network/core";
import { AsyncRineClient } from "@rine-network/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initHost } from "../../src/identity/branch-init.js";
import { provisionBinding } from "../../src/identity/provision.js";
import { bindingKey } from "../../src/identity/paths.js";
import { parsePolicy } from "../../src/policy/schema.js";
import { BindingSchema, BindingState, type Host } from "../../src/types.js";
import { API, type Rig, makeRig } from "./harness.js";

let rig: Rig;
let host: Host;
beforeEach(async () => {
	rig = makeRig();
	host = await initHost({ paths: rig.paths, apiUrl: API, ownerDir: rig.ownerDir, hostname: "tank" });
});
afterEach(() => rig.cleanup());

const policy = parsePolicy('[[agents]]\nname = "reviewer"\nrole = "code-review"');
const pane = { repoRoot: "/work/My Repo", herdrName: "lead" };

describe("provisionBinding", () => {
	it("returns a pending binding with no tools", async () => {
		const binding = await provisionBinding(rig.paths, host, pane, policy, () => new Date("2026-11-13T10:00:00Z"));
		expect(BindingSchema.parse(binding)).toEqual(binding);
		expect(binding).toMatchObject({
			key: bindingKey(pane.repoRoot, "lead"),
			state: BindingState.PendingApply,
			tools: [],
			appliedAt: null,
			createdAt: "2026-11-13T10:00:00.000Z",
			handle: "my-repo-lead@acme.rine.network",
		});
	});

	it("creates the agent under the host branch and private", async () => {
		await provisionBinding(rig.paths, host, pane, policy);
		const [create] = rig.fake.callsTo("POST", /^\/agents$/);
		expect(create?.body["exposure"]).toBe("private");
		expect(create?.body["name"]).toBe("my-repo-lead");
	});

	it("names the agent after the role the policy file gives the herdr name", async () => {
		const binding = await provisionBinding(rig.paths, host, { ...pane, herdrName: "reviewer" }, policy);
		expect(rig.fake.agents.get(binding.agentId)?.name).toBe("my-repo-code-review");
	});

	it("leaves a pane dir that works as an agent-only client", async () => {
		const binding = await provisionBinding(rig.paths, host, pane, policy);
		expect(statSync(binding.configDir).mode & 0o777).toBe(0o700);
		expect(getProfile(binding.configDir, DEFAULT_PROFILE)?.agent_id).toBe(binding.agentId);
		expect(existsSync(join(binding.configDir, "keys", binding.agentId))).toBe(true);
		const client = new AsyncRineClient({ configDir: binding.configDir, agentOnly: true, apiUrl: API });
		const who = await client.whoami();
		expect(who.agents.map((a) => a.id)).toContain(binding.agentId);
	});

	it("keeps agent keys out of the branch home", async () => {
		const binding = await provisionBinding(rig.paths, host, pane, policy);
		expect(existsSync(join(rig.paths.branchHome, "keys", binding.agentId))).toBe(false);
	});

	it("retries once with the host slug when the name is taken", async () => {
		rig.fake.agents.set(crypto.randomUUID(), { id: crypto.randomUUID(), name: "my-repo-lead", handle: "x@acme", incoming_policy: "accept_all", outgoing_policy: "send_all", preset: "findable" });
		const binding = await provisionBinding(rig.paths, host, pane, policy);
		expect(rig.fake.agents.get(binding.agentId)?.name).toBe("my-repo-lead-tank");
	});

	it("explains itself when both names are taken", async () => {
		for (const name of ["my-repo-lead", "my-repo-lead-tank"]) {
			const id = crypto.randomUUID();
			rig.fake.agents.set(id, { id, name, handle: `${name}@acme`, incoming_policy: "accept_all", outgoing_policy: "send_all", preset: "findable" });
		}
		await expect(provisionBinding(rig.paths, host, pane, policy)).rejects.toThrow(/both taken/);
	});

	it("refuses a pane dir that already holds an identity", async () => {
		await provisionBinding(rig.paths, host, pane, policy);
		await expect(provisionBinding(rig.paths, host, pane, policy)).rejects.toThrow(/already holds an agent identity/);
	});
});
