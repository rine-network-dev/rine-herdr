import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEASE_TTL_MS, leasePaths, leaseVerdict } from "../../src/daemon/cc-lease.js";
import { AGENT_ID } from "./fixtures.js";

const NOW = 1_000_000_000;
const OTHER = "55555555-5555-4555-8555-555555555555";

describe("cc lease", () => {
	let home: string;
	let cwd: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "rh-home-"));
		cwd = mkdtempSync(join(tmpdir(), "rh-cwd-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	const sealed = (body: object): string => {
		const text = JSON.stringify(body);
		return `${createHash("sha256").update(text).digest("hex")}\n${text}`;
	};
	const write = (path: string, text: string, mtimeMs = NOW): void => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
	};
	const live = (agentId: string, heartbeatAt = NOW - 1_000) => sealed({ agentId, heartbeatAt, releasedAt: null, nonce: "n" });

	it("leasePaths_followsThePluginResolutionOrder", () => {
		expect(leasePaths("/h", "/c")).toEqual(["/h/.config/rine/state/cc/lease.json", "/c/.rine/state/cc/lease.json"]);
		expect(leasePaths("/h", null)).toEqual(["/h/.config/rine/state/cc/lease.json"]);
	});

	it("leaseVerdict_noFiles_doesNotDefer", () => {
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW)).toEqual({ defer: false, foreignAgentId: null });
	});

	it("leaseVerdict_liveLeaseForThisAgent_defersFromEitherLocation", () => {
		const [user, project] = leasePaths(home, cwd) as [string, string];
		write(project, live(AGENT_ID));
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW).defer).toBe(true);
		rmSync(project);
		write(user, live(AGENT_ID));
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW).defer).toBe(true);
	});

	it("leaseVerdict_liveLeaseForAnotherAgent_doesNotDeferButIsReported", () => {
		write((leasePaths(home, cwd) as [string])[0], live(OTHER));
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW)).toEqual({ defer: false, foreignAgentId: OTHER });
	});

	it("leaseVerdict_releasedLease_doesNotDefer", () => {
		write((leasePaths(home, cwd) as [string])[0], sealed({ agentId: AGENT_ID, heartbeatAt: NOW - 1000, releasedAt: NOW - 500 }));
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW).defer).toBe(false);
	});

	it("leaseVerdict_staleHeartbeat_doesNotDefer", () => {
		write((leasePaths(home, cwd) as [string])[0], live(AGENT_ID, NOW - LEASE_TTL_MS));
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW).defer).toBe(false);
	});

	it("leaseVerdict_badSeal_countsAsHeldFor30sFromMtime", () => {
		const path = (leasePaths(home, cwd) as [string])[0];
		write(path, `${"0".repeat(64)}\n{"agentId":"${AGENT_ID}"}`, NOW - 5_000);
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW).defer).toBe(true);
		write(path, "garbage", NOW - LEASE_TTL_MS - 1);
		expect(leaseVerdict(AGENT_ID, home, cwd, NOW).defer).toBe(false);
	});

	it("leaseVerdict_nullCwd_readsOnlyTheUserLevelFile", () => {
		write((leasePaths(home, cwd) as [string, string])[1], live(AGENT_ID));
		expect(leaseVerdict(AGENT_ID, home, null, NOW).defer).toBe(false);
	});
});
