import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/init.js";
import { initHost, loadHost } from "../../src/identity/branch-init.js";
import { ownerDirAdvice } from "../../src/identity/clients.js";
import { HostSchema } from "../../src/types.js";
import { API, ORG_ID, type Rig, makeRig } from "./harness.js";

let rig: Rig;
beforeEach(() => {
	rig = makeRig();
});
afterEach(() => rig.cleanup());

const init = () => initHost({ paths: rig.paths, apiUrl: API, ownerDir: rig.ownerDir, hostname: "Tank.local" });

describe("ownerDirAdvice", () => {
	it("is one warning, which calls out the persistent default dir by name", () => {
		expect(ownerDirAdvice(rig.ownerDir)).toMatch(/^warning: the owner key in .* sits on a host that runs agents/);
		const advice = ownerDirAdvice(join(homedir(), ".config", "rine-owner"));
		expect(advice).toContain("~/.config/rine-owner is the persistent default");
		expect(advice.split("\n")).toHaveLength(1);
	});
});

describe("initHost", () => {
	it("publishes the branch and writes a host.json that parses", async () => {
		const host = await init();
		expect(host).toMatchObject({ branch: "herdr-tank-local", orgId: ORG_ID, orgSlug: "acme", hostSlug: "tank-local" });
		expect(HostSchema.parse(JSON.parse(readFileSync(rig.paths.host, "utf8")))).toEqual(host);
		expect(rig.fake.callsTo("POST", /^\/orgs\/me\/branches$/)).toHaveLength(1);
	});

	it("is idempotent: a second run meets a 409 and reuses the branch", async () => {
		const first = await init();
		const second = await init();
		expect(second).toEqual(first);
		expect(rig.fake.callsTo("POST", /^\/orgs\/me\/branches$/)).toHaveLength(2);
	});

	it("leaves only branch keys in branch-home, never the org root", async () => {
		await init();
		const files = readdirSync(rig.paths.branchHome, { recursive: true, encoding: "utf8" });
		expect(files.some((f) => /root\.key|recovery-phrase/.test(f))).toBe(false);
		expect(files.some((f) => f.startsWith("branch"))).toBe(true);
		expect(readdirSync(rig.paths.emptyOwner)).toEqual([]);
		expect(existsSync(join(rig.ownerDir, "root.key"))).toBe(true);
	});

	it("fails with a pointer to the owner dir when it holds no org root", async () => {
		await expect(initHost({ paths: rig.paths, apiUrl: API, ownerDir: join(rig.stateDir, "elsewhere"), hostname: "tank" })).rejects.toThrow(/no org root/);
	});

	it("refuses --new-org into an owner dir that already has files", async () => {
		await expect(
			initHost({ paths: rig.paths, apiUrl: API, ownerDir: rig.ownerDir, hostname: "tank", newOrg: { email: "a@b.c", slug: "acme", name: "Acme" } }),
		).rejects.toThrow(/not empty/);
	});
});

describe("loadHost", () => {
	it("tells the operator to run init when there is no host file", () => {
		expect(() => loadHost(rig.paths)).toThrow(/run `rine-herdr init` first/);
	});
});

describe("runInit", () => {
	const io = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), confirm: async () => false } };
	};

	it("prints the host summary and exits 0", async () => {
		const c = io();
		expect(await runInit(["--api-url", API], c.io, rig.stateDir)).toBe(0);
		expect(c.out.join("\n")).toMatch(/host ready: branch herdr-.* in org acme/);
	});

	it("exits 2 when --new-org lacks its details", async () => {
		const c = io();
		expect(await runInit(["--new-org", "--email", "a@b.c"], c.io, rig.stateDir)).toBe(2);
		expect(c.err.join("\n")).toMatch(/--org-slug/);
	});
});
