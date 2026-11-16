// The cc plugin's lease and our deferral must agree on file format and wake limits. The plugin lives in
// the monorepo only (the public mirror has no cc-plugin), so this contract skips when its sources are absent.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { leasePaths, leaseVerdict, LEASE_TTL_MS } from "../../src/daemon/cc-lease.js";
import { WAKE_SPACING_MS, WAKES_PER_HOUR } from "../../src/daemon/wake-budget.js";

const PLUGIN_LIB = resolve(__dirname, "../../../rine-cc-plugin/plugins/rine/hooks/lib");
const present = existsSync(join(PLUGIN_LIB, "lease.ts")) && existsSync(join(PLUGIN_LIB, "envelope.ts"));
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

// A computed specifier keeps the plugin's sources out of this package's typecheck.
const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ join(PLUGIN_LIB, file)) as Promise<T>;

describe.skipIf(!present)("cc-plugin lease contract", () => {
	it("wakeConstants_equalThePluginsOwn", async () => {
		const lease = await load<{ WAKE_SPACING_MS: number; WAKES_PER_HOUR: number; LEASE_TTL_MS: number }>("lease.ts");
		expect(WAKE_SPACING_MS).toBe(lease.WAKE_SPACING_MS);
		expect(WAKES_PER_HOUR).toBe(lease.WAKES_PER_HOUR);
		expect(LEASE_TTL_MS).toBe(lease.LEASE_TTL_MS);
	});

	it("leaseSealedByThePlugin_isReadAsLiveForItsAgentAndNotForAnother", async () => {
		const { seal } = await load<{ seal(body: string): Promise<string> }>("envelope.ts");
		const home = mkdtempSync(join(tmpdir(), "rh-contract-home-"));
		try {
			const now = Date.now();
			const record = { nonce: "n".repeat(32), agentId: AGENT_ID, sessionId: "s", cwd: "/repo", heartbeatAt: now - 2_000, releasedAt: null, wakes: [] };
			const [path = ""] = leasePaths(home, null);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, await seal(JSON.stringify(record)));
			expect(leaseVerdict(AGENT_ID, home, null, now).defer).toBe(true);
			expect(leaseVerdict("55555555-5555-4555-8555-555555555555", home, null, now)).toMatchObject({ defer: false });
			writeFileSync(path, await seal(JSON.stringify({ ...record, releasedAt: now })));
			expect(leaseVerdict(AGENT_ID, home, null, now).defer).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("leasePath_isTheFileThePluginWritesUnderEachRineDir", async () => {
		const { statePath } = await load<{ statePath(rineDir: string, file: "lease"): string }>("refs.ts");
		expect(leasePaths("/h", "/c")).toEqual([statePath("/h/.config/rine", "lease"), statePath("/c/.rine", "lease")]);
	});
});
