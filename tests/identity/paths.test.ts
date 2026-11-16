import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_DIR_ENV, bindingKey, ensureStateDirs, resolveStateDir, statePaths } from "../../src/identity/paths.js";

const fresh = () => statePaths(join(mkdtempSync(join(tmpdir(), "rine-herdr-paths-")), "state"));

describe("ensureStateDirs", () => {
	it("creates every state directory with mode 0700", () => {
		const paths = fresh();
		ensureStateDirs(paths);
		for (const dir of [paths.root, paths.branchHome, paths.agents, paths.emptyOwner, paths.bin]) {
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		}
	});

	it("is idempotent", () => {
		const paths = fresh();
		ensureStateDirs(paths);
		expect(() => ensureStateDirs(paths)).not.toThrow();
	});

	it("tightens a directory that already exists with looser permissions", () => {
		const paths = fresh();
		mkdirSync(paths.root, { recursive: true, mode: 0o755 });
		ensureStateDirs(paths);
		expect(statSync(paths.root).mode & 0o777).toBe(0o700);
	});

	it("refuses when the empty owner directory is not empty", () => {
		const paths = fresh();
		ensureStateDirs(paths);
		writeFileSync(join(paths.emptyOwner, "root.key"), "x");
		expect(() => ensureStateDirs(paths)).toThrow(/empty-owner/);
	});
});

describe("bindingKey", () => {
	it("is 16 hex characters and stable for one repo and name", () => {
		const key = bindingKey("/work/repo", "lead");
		expect(key).toMatch(/^[0-9a-f]{16}$/);
		expect(bindingKey("/work/repo", "lead")).toBe(key);
	});

	it("differs by repo and by name", () => {
		const keys = new Set([bindingKey("/a", "lead"), bindingKey("/b", "lead"), bindingKey("/a", "dev")]);
		expect(keys.size).toBe(3);
	});
});

describe("resolveStateDir", () => {
	it("prefers the environment variable", () => {
		expect(resolveStateDir({ [STATE_DIR_ENV]: "/x/y" })).toBe("/x/y");
	});
});
