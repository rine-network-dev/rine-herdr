import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApply, runApplyFromPane, runPlan } from "../../src/cli/commands/apply.js";
import type { CliIo } from "../../src/cli/io.js";
import { initHost } from "../../src/identity/branch-init.js";
import { provisionBinding } from "../../src/identity/provision.js";
import { readApplied } from "../../src/policy/applied.js";
import { parsePolicy } from "../../src/policy/schema.js";
import type { Binding } from "../../src/types.js";
import { API, type Rig, makeRig } from "./harness.js";
import { fakePort } from "./port.js";

let rig: Rig;
let repo: string;
let bindings: Binding[];

beforeEach(async () => {
	rig = makeRig();
	repo = join(mkdtempSync(join(tmpdir(), "rine-herdr-repo-")), "repo");
	mkdirSync(repo);
	commitPolicy("");
	const host = await initHost({ paths: rig.paths, apiUrl: API, ownerDir: rig.ownerDir, hostname: "tank" });
	const policy = parsePolicy("");
	bindings = [];
	for (const herdrName of ["lead", "dev"]) {
		bindings.push(await provisionBinding(rig.paths, host, { repoRoot: repo, herdrName }, policy));
	}
	rig.fake.calls.length = 0;
	port = fakePort(bindings);
});
afterEach(() => rig.cleanup());

/** Writes the policy file into the repo and commits it, so provenance reads clean. */
function commitPolicy(text: string): void {
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
	if (!existsSync(join(repo, ".git"))) git("init", "-q");
	writeFileSync(join(repo, "rine-herdr.toml"), text);
	git("add", "rine-herdr.toml");
	git("commit", "-q", "-m", "policy");
}

function capture(answer = true) {
	const out: string[] = [];
	const err: string[] = [];
	const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), confirm: async () => answer };
	return { out, err, io, text: () => [...out, ...err].join("\n") };
}

const TEAM = 'profile = "team"\n[external]\norgs = ["7c1e0a52-3b0f-4d6e-9a41-0f2d5c7b8e13"]\n';
let port: ReturnType<typeof fakePort>;
const deps = () => ({ ipc: port, stateDir: rig.stateDir });
const writes = () => rig.fake.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/g, "{id}")}`);

describe("plan", () => {
	it("lists the steps and writes nothing", async () => {
		const c = capture();
		expect(await runPlan(["--repo", repo], c.io, deps())).toBe(0);
		expect(c.text()).toMatch(/create group herdr-/);
		expect(writes()).toEqual([]);
	});

	it("reports nothing to do once the server matches", async () => {
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		const c = capture();
		expect(await runPlan(["--repo", repo], c.io, deps())).toBe(0);
		expect(c.text()).toMatch(/nothing to do/);
	});

	it("refuses and exits 1 when the group quota cannot hold the plan, where the owner reads quota", async () => {
		commitPolicy(TEAM);
		rig.fake.groupLimit = 0;
		const c = capture();
		expect(await runPlan(["--repo", repo], c.io, deps())).toBe(1);
		expect(c.err.join("\n")).toMatch(/refused: needs 1 new group but the org has used 0 of 0 allowed/);
	});

	it("notes that [external] has no effect under solo", async () => {
		writeFileSync(join(repo, "rine-herdr.toml"), "[external]\norgs = []\n");
		const c = capture();
		await runPlan(["--repo", repo], c.io, deps());
		expect(c.text()).toMatch(/\[external\] has no effect under the solo profile/);
	});
});

describe("policy provenance", () => {
	const dirty = () => writeFileSync(join(repo, "rine-herdr.toml"), "profile = \"open\"\n");

	it("plan warns about an uncommitted policy file and still exits 0", async () => {
		dirty();
		const c = capture();
		expect(await runPlan(["--repo", repo], c.io, deps())).toBe(0);
		expect(c.err.join("\n")).toMatch(/warning: rine-herdr.toml is not committed/);
	});

	it("plan does not warn once the policy is committed", async () => {
		const c = capture();
		await runPlan(["--repo", repo], c.io, deps());
		expect(c.err).toEqual([]);
	});

	it("apply refuses an uncommitted policy file and changes nothing", async () => {
		dirty();
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.err.join("\n")).toMatch(/refused: rine-herdr.toml is not committed.*--allow-dirty/);
		expect(writes()).toEqual([]);
		expect(port.applied).toEqual([]);
	});

	it("apply goes ahead on an uncommitted policy file with --allow-dirty", async () => {
		dirty();
		expect(await runApply(["--repo", repo, "--yes", "--allow-dirty"], capture().io, deps())).toBe(0);
		expect(port.applied.length).toBeGreaterThan(0);
	});
});

describe("apply", () => {
	it("creates the group, joins it, then patches both agents, in that order", async () => {
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		const order = writes().filter((w) => !w.includes("/mls") && !w.includes("key-packages"));
		const create = order.indexOf("POST /groups");
		const join = order.indexOf("POST /groups/{id}/join");
		const firstPatch = order.indexOf("PATCH /agents/{id}");
		expect(create).toBeGreaterThanOrEqual(0);
		expect(join).toBeGreaterThan(create);
		expect(firstPatch).toBeGreaterThan(join);
		expect(order.filter((w) => w === "PATCH /agents/{id}")).toHaveLength(2);
		expect(port.applied.map((a) => a.keys[0]).sort()).toEqual(bindings.map((b) => b.key).sort());
	});

	it("sets groups_only policy and private exposure on the server", async () => {
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		for (const agent of rig.fake.agents.values()) {
			expect(agent).toMatchObject({ incoming_policy: "groups_only", outgoing_policy: "groups_only", preset: "private" });
		}
	});

	it("hands markApplied the tool list of each binding", async () => {
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		expect(port.applied.length).toBeGreaterThan(0);
		for (const { keys, tools } of port.applied) expect((tools[keys[0] ?? ""] ?? []).length).toBeGreaterThan(0);
	});

	it("stops at a refused step and lists what did not run", async () => {
		rig.fake.refuse.set("PATCH /agents/" + bindings[0]?.agentId, 403);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.err.join("\n")).toMatch(/stopped after \d+ steps; not run:/);
		expect(c.out.join("\n")).toMatch(/FAILED/);
		expect(port.applied).toEqual([]);
	});

	it("warns when a created group could not start its MLS state", async () => {
		const c = capture();
		await runApply(["--repo", repo, "--yes"], c.io, deps());
		expect(c.out.join("\n")).toMatch(/warning: group herdr-[0-9a-f]{12} exists but its post-quantum MLS state did not start/);
	});

	it("does nothing when the operator declines", async () => {
		const c = capture(false);
		expect(await runApply(["--repo", repo], c.io, deps())).toBe(1);
		expect(writes()).toEqual([]);
		expect(c.err).toEqual(["Nothing changed."]);
	});

	const OUTSIDER = "00000000-0000-4000-8000-0000000000ff";
	/** A herdr-made group the policy does not want, seated with `members`; `admins` hold the admin role. */
	const seedStale = (members: readonly string[], admins: readonly string[]) => {
		const group = { id: crypto.randomUUID(), name: "herdr-aaaaaaaaaaaa", handle: "#herdr-aaaaaaaaaaaa@acme", members: new Set(members), admins: new Set(admins) };
		rig.fake.groups.push(group);
		return group;
	};
	const [lead, dev] = [() => bindings[0]?.agentId ?? "", () => bindings[1]?.agentId ?? ""];

	it("dissolves a stale group of only this repo's agents, by the one that administers it", async () => {
		const stale = seedStale([lead(), dev()], [dev()]);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.out.join("\n")).toMatch(/dev dissolves stale group herdr-aaaaaaaaaaaa/);
		expect(rig.fake.groups.map((g) => g.name)).not.toContain(stale.name);
	});

	it("leaves, never deletes, a stale group someone outside the repo sits in", async () => {
		const stale = seedStale([lead(), dev(), OUTSIDER], [lead()]);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.out.join("\n")).toMatch(/dev leaves stale group herdr-aaaaaaaaaaaa/);
		expect(rig.fake.callsTo("DELETE", /^\/groups\/[0-9a-f-]{36}$/)).toHaveLength(0);
		expect([...stale.members]).toEqual([lead(), OUTSIDER]);
	});

	it("fails on a stale group nobody here can delete or leave, touches nothing, and does not record the policy", async () => {
		const stale = seedStale([lead(), OUTSIDER], [lead()]);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.err.join("\n")).toMatch(/stuck: stale group herdr-aaaaaaaaaaaa: .*neither deleted nor left/);
		expect(c.err.at(-1)).toMatch(/a stale group could be neither dissolved nor left .*not recorded as applied; run apply again/);
		expect(rig.fake.callsTo("DELETE", /^\/groups\//)).toHaveLength(0);
		expect(stale.members.size).toBe(2);
		expect(readApplied(rig.paths, repo)).toBeNull();
	});

	it("plans a stuck stale group as a note and never says there is nothing to do", async () => {
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		seedStale([lead(), OUTSIDER], [lead()]);
		const c = capture();
		expect(await runPlan(["--repo", repo], c.io, deps())).toBe(0);
		expect(c.out.join("\n")).toMatch(/note: stale group herdr-aaaaaaaaaaaa/);
		expect(c.out.join("\n")).not.toMatch(/nothing to do/);
	});

	it("keeps the tools of bindings whose own steps succeeded when an unrelated stale group is stuck, and plans the group again", async () => {
		seedStale([lead(), OUTSIDER], [lead()]);
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		expect(port.applied.length).toBeGreaterThan(0);
		const again = capture();
		expect(await runApply(["--repo", repo, "--yes"], again.io, deps())).toBe(1);
		expect(again.out.join("\n")).toMatch(/note: stale group herdr-aaaaaaaaaaaa/);
		expect(port.applied).toHaveLength(bindings.length);
	});

	it("carries on past a stale group that cannot be dissolved, exits 1 and does not record the policy as applied", async () => {
		const stale = seedStale([lead(), dev()], [lead()]);
		rig.fake.refuse.set(`DELETE /groups/${stale.id}`, 403);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.out.join("\n")).toMatch(/FAILED .*dissolves stale group herdr-aaaaaaaaaaaa/);
		expect(c.err.join("\n")).toMatch(/a stale group could be neither dissolved nor left .*not recorded as applied/);
		expect(rig.fake.callsTo("PATCH", /^\/agents\//)).toHaveLength(2);
		expect(port.applied.length).toBeGreaterThan(0);
		expect(readApplied(rig.paths, repo)).toBeNull();
	});

	it("is a no-op the second time", async () => {
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		rig.fake.calls.length = 0;
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(writes()).toEqual([]);
	});
});

describe("authority", () => {
	const OLD_SERVER = { status: 403, detail: "principal not permitted on this route" };
	const refuseBranchPatch = (refusal: { status: number; detail: string; error?: string }) =>
		bindings.forEach((b) => rig.fake.refuseBranch.set(`PATCH /agents/${b.agentId}`, refusal));
	const patchers = () => rig.fake.callsTo("PATCH", /^\/agents\//).map((c) => c.caller.split(":")[0]);
	const noOwnerDir = () => vi.stubEnv("RINE_OWNER_DIR", mkdtempSync(join(tmpdir(), "rine-herdr-empty-owner-")));

	it("solo applies on the branch key alone: no owner dir read, no owner advice, no quota or allow read", async () => {
		noOwnerDir();
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.out.join("\n")).toMatch(/authority: branch .* \(no owner directory needed\)/);
		expect(c.text()).not.toMatch(/the owner key in/);
		expect(patchers()).toEqual(["branch", "branch"]);
		expect(rig.fake.calls.filter((x) => /^\/org\/(quotas|allow)/.test(x.path))).toEqual([]);
	});

	it("says the group quota is unchecked when the branch plans a group", async () => {
		const c = capture();
		await runPlan(["--repo", repo], c.io, deps());
		expect(c.out.join("\n")).toMatch(/note: the server checks the group quota when each group is created/);
	});

	it("a team policy with external orgs under enforce loads the owner for the allow entries only", async () => {
		commitPolicy(TEAM);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.out.at(-1)).toBe("applied 10 steps");
		expect(c.err.filter((l) => /the owner key in/.test(l))).toHaveLength(1);
		expect(c.err.at(-1)).toMatch(/^warning: the owner key in .* sits on a host that runs agents/);
		expect(c.out.join("\n")).toMatch(/authority: branch .*; org owner for allow entries/);
		expect(rig.fake.callsTo("PUT", /^\/org\/allow/).every((x) => x.caller.startsWith("org:"))).toBe(true);
		expect(patchers()).toEqual(["branch", "branch"]);
	});

	it("a team policy needs no owner when the org does not enforce external rules", async () => {
		rig.fake.modes.external_inbound = "off";
		rig.fake.modes.external_outbound = "off";
		commitPolicy(TEAM);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.text()).not.toMatch(/the owner key in/);
		expect(rig.fake.callsTo("PUT", /^\/org\/allow/)).toEqual([]);
	});

	it("new_agents enforce does not make external rules look enforced: a team policy applies with no allow steps", async () => {
		rig.fake.modes.external_inbound = "off";
		rig.fake.modes.external_outbound = "off";
		rig.fake.modes.new_agents = "enforce";
		commitPolicy(TEAM);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.out.join("\n")).toMatch(/the org does not enforce external message rules, so no allow entries are needed/);
		expect(c.text()).not.toMatch(/FAILED|Owner directory:/);
		expect(rig.fake.callsTo("PUT", /^\/org\/allow/)).toEqual([]);
	});

	it("loosening under new_agents enforce loads the owner and the owner writes the policy", async () => {
		rig.fake.modes.new_agents = "enforce";
		for (const agent of rig.fake.agents.values()) Object.assign(agent, { incoming_policy: "groups_only", outgoing_policy: "groups_only" });
		commitPolicy('profile = "open"\n');
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.out.join("\n")).toMatch(/authority: org owner \(the org stops new agents/);
		expect(patchers()).toEqual(["org", "org"]);
	});

	it("tightening under new_agents enforce stays on the branch", async () => {
		rig.fake.modes.new_agents = "enforce";
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.text()).not.toMatch(/the owner key in/);
		expect(patchers()).toEqual(["branch", "branch"]);
	});

	it("an older server's refusal continues as the owner, saying so once, and the policy lands", async () => {
		refuseBranchPatch(OLD_SERVER);
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		const text = c.out.join("\n");
		expect(text.match(/does not let a branch key set agent policy yet; continuing as the org owner/g)).toHaveLength(1);
		expect(patchers()).toEqual(["branch", "org", "org"]);
		for (const agent of rig.fake.agents.values()) expect(agent).toMatchObject({ incoming_policy: "groups_only", outgoing_policy: "groups_only" });
	});

	it("an older server with no owner root fails the step with the owner-dir advice and lists the rest", async () => {
		refuseBranchPatch(OLD_SERVER);
		noOwnerDir();
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.out.join("\n")).toMatch(/FAILED .*this rine server needs the org owner to set agent policy; set RINE_OWNER_DIR to the owner directory/);
		expect(c.err.join("\n")).toMatch(/stopped after \d+ steps; not run:/);
		expect(c.err.filter((l) => /talks only to its groups/.test(l))).toHaveLength(2);
		expect(port.applied).toEqual([]);
	});

	it("an org that stopped new agents mid-apply sends the loosening to the owner", async () => {
		refuseBranchPatch({ status: 403, detail: "New agents are stopped", error: "new_agents_stopped" });
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(0);
		expect(c.out.join("\n")).toMatch(/the org stops new agents, so only the org loosens an agent's policy; continuing as the org owner/);
	});

	it("a hold refusal never falls back to the owner", async () => {
		refuseBranchPatch({ status: 403, detail: "Agent is suspended", error: "agent_suspended" });
		const c = capture();
		expect(await runApply(["--repo", repo, "--yes"], c.io, deps())).toBe(1);
		expect(c.text()).not.toMatch(/continuing as the org owner/);
		expect(patchers()).toEqual(["branch"]);
	});
});

describe("last applied policy", () => {
	it("says there is no earlier apply, then records the hash and reports the file unchanged", async () => {
		const first = capture();
		await runApply(["--repo", repo, "--yes"], first.io, deps());
		expect(first.out.join("\n")).toMatch(/no earlier apply of a policy in this repo/);
		const second = capture();
		await runPlan(["--repo", repo], second.io, deps());
		expect(second.out.join("\n")).toMatch(/policy unchanged since the last apply on \d{4}-\d{2}-\d{2}/);
	});

	it("names both hashes when the committed policy moved since", async () => {
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		commitPolicy('profile = "open"\n');
		const c = capture();
		await runPlan(["--repo", repo], c.io, deps());
		expect(c.out.join("\n")).toMatch(/policy changed since the last apply on \d{4}-\d{2}-\d{2} \([0-9a-f]{8} → [0-9a-f]{8}\); review `git log -p rine-herdr.toml`/);
	});

	it("a failed apply records nothing", async () => {
		rig.fake.refuse.set(`PATCH /agents/${bindings[0]?.agentId}`, 500);
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		const c = capture();
		await runPlan(["--repo", repo], c.io, deps());
		expect(c.out.join("\n")).toMatch(/no earlier apply of a policy in this repo/);
	});

	it("a refused uncommitted apply records nothing", async () => {
		writeFileSync(join(repo, "rine-herdr.toml"), 'profile = "open"\n');
		await runApply(["--repo", repo, "--yes"], capture().io, deps());
		const c = capture();
		await runPlan(["--repo", repo], c.io, deps());
		expect(c.out.join("\n")).toMatch(/no earlier apply of a policy in this repo/);
	});
});

describe("pane apply", () => {
	it("refuses an uncommitted policy file and never applies it", async () => {
		writeFileSync(join(repo, "rine-herdr.toml"), 'profile = "open"\n');
		const c = capture(true);
		expect(await runApplyFromPane(repo, c.io, deps())).toBe(1);
		expect(c.err.join("\n")).toMatch(/refused: rine-herdr.toml is not committed/);
		expect(writes()).toEqual([]);
	});

	it("applies a committed policy after the operator confirms", async () => {
		const c = capture(true);
		expect(await runApplyFromPane(repo, c.io, deps())).toBe(0);
		expect(port.applied.length).toBeGreaterThan(0);
	});
});
