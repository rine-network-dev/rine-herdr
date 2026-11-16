import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appliedLine, readApplied, recordApplied } from "../../src/policy/applied.js";

const paths = () => ({ appliedPolicy: join(mkdtempSync(join(tmpdir(), "rine-herdr-applied-")), "applied-policy.json") });
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("applied policy record", () => {
	it("reads nothing before the first record", () => {
		expect(readApplied(paths(), "/work/a")).toBeNull();
	});

	it("keeps one entry per repo and replaces a repo's entry on the next record", () => {
		const p = paths();
		recordApplied(p, "/work/a", HASH_A, new Date("2026-11-13T10:00:00Z"));
		recordApplied(p, "/work/b", HASH_B, new Date("2026-11-13T11:00:00Z"));
		recordApplied(p, "/work/a", HASH_B, new Date("2026-11-14T09:00:00Z"));
		expect(readApplied(p, "/work/a")).toEqual({ hash: HASH_B, at: "2026-11-14T09:00:00.000Z" });
		expect(readApplied(p, "/work/b")).toEqual({ hash: HASH_B, at: "2026-11-13T11:00:00.000Z" });
	});

	it("reads an unreadable record as no earlier apply", () => {
		const p = paths();
		writeFileSync(p.appliedPolicy, "{not json");
		expect(readApplied(p, "/work/a")).toBeNull();
	});
});

describe("appliedLine", () => {
	const last = { hash: HASH_A, at: "2026-11-13T10:00:00.000Z" };

	it("says there is no earlier apply", () => {
		expect(appliedLine(null, HASH_A)).toBe("no earlier apply of a policy in this repo");
	});

	it("says unchanged when the hash matches", () => {
		expect(appliedLine(last, HASH_A)).toBe("policy unchanged since the last apply on 2026-11-13");
	});

	it("names eight characters of each hash when the policy moved", () => {
		expect(appliedLine(last, HASH_B)).toBe("policy changed since the last apply on 2026-11-13 (aaaaaaaa → bbbbbbbb); review `git log -p rine-herdr.toml`");
	});

	it("reads an absent policy file as none", () => {
		expect(appliedLine(last, null)).toMatch(/\(aaaaaaaa → none\)/);
	});
});
