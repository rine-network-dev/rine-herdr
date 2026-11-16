// provenance.ts — is the policy file the one that was committed? The working tree is writable by the agents it
// governs (and herdr's unauthenticated socket can open the apply popup and type into it), so plan/apply must not
// treat an uncommitted `rine-herdr.toml` as reviewed. Callers refuse or flag when `uncommitted` is true.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_FILE } from "./schema.js";

export interface PolicyProvenance {
	/** sha256 of the file on disk; `null` when absent (the solo defaults). Record it at apply, diff against it at the next. */
	hash: string | null;
	/** The file on disk differs from HEAD, is untracked, or git cannot confirm it. An absent file absent from HEAD is clean. */
	uncommitted: boolean;
}

function readDisk(repoRoot: string): Buffer | null {
	try {
		return readFileSync(join(repoRoot, POLICY_FILE));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** The bytes at HEAD; `null` when HEAD has no such file. A git failure (no repo, no commits) reads as unconfirmed. */
function readHead(repoRoot: string): Buffer | null | undefined {
	const git = (args: string[]): Buffer => execFileSync("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "ignore"] });
	try {
		const tracked = git(["ls-tree", "--name-only", "HEAD", "--", POLICY_FILE]).toString().trim() !== "";
		return tracked ? git(["show", `HEAD:${POLICY_FILE}`]) : null;
	} catch {
		return undefined;
	}
}

export function policyProvenance(repoRoot: string): PolicyProvenance {
	const disk = readDisk(repoRoot);
	const head = readHead(repoRoot);
	const hash = disk === null ? null : createHash("sha256").update(disk).digest("hex");
	if (head === undefined) return { hash, uncommitted: true };
	return { hash, uncommitted: !(disk === null ? head === null : head !== null && disk.equals(head)) };
}
