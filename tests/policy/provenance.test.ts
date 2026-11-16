import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { policyProvenance } from "../../src/policy/provenance.js";
import { POLICY_FILE } from "../../src/policy/schema.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "rine-herdr-prov-"));
	dirs.push(dir);
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "init");
	return dir;
}
const commit = (dir: string) => {
	execFileSync("git", ["-C", dir, "add", POLICY_FILE], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "policy"], { stdio: "ignore" });
};

describe("policyProvenance", () => {
	it("test_policyProvenance_absentFileAbsentFromHead_isClean", () => {
		expect(policyProvenance(repo())).toEqual({ hash: null, uncommitted: false });
	});

	it("test_policyProvenance_untrackedFile_isUncommitted", () => {
		const dir = repo();
		writeFileSync(join(dir, POLICY_FILE), 'profile = "open"\n');
		expect(policyProvenance(dir).uncommitted).toBe(true);
	});

	it("test_policyProvenance_committedFile_isClean", () => {
		const dir = repo();
		writeFileSync(join(dir, POLICY_FILE), 'profile = "team"\n');
		commit(dir);
		const p = policyProvenance(dir);
		expect(p.uncommitted).toBe(false);
		expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("test_policyProvenance_editedAfterCommit_isUncommittedWithNewHash", () => {
		const dir = repo();
		writeFileSync(join(dir, POLICY_FILE), 'profile = "team"\n');
		commit(dir);
		const before = policyProvenance(dir).hash;
		writeFileSync(join(dir, POLICY_FILE), 'profile = "open"\n');
		const after = policyProvenance(dir);
		expect(after.uncommitted).toBe(true);
		expect(after.hash).not.toBe(before);
	});

	it("test_policyProvenance_fileDeletedAfterCommit_isUncommitted", () => {
		const dir = repo();
		writeFileSync(join(dir, POLICY_FILE), 'profile = "team"\n');
		commit(dir);
		rmSync(join(dir, POLICY_FILE));
		expect(policyProvenance(dir)).toEqual({ hash: null, uncommitted: true });
	});

	it("test_policyProvenance_notAGitRepo_isUncommitted", () => {
		const dir = mkdtempSync(join(tmpdir(), "rine-herdr-prov-"));
		dirs.push(dir);
		writeFileSync(join(dir, POLICY_FILE), 'profile = "team"\n');
		expect(policyProvenance(dir).uncommitted).toBe(true);
	});
});
