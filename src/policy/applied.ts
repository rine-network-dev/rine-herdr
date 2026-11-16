// applied.ts — the policy each repo last applied, so the next plan can say what changed since. A review aid: anyone
// who can write the state dir can edit it, so it informs the operator and gates nothing.
import { readFileSync } from "node:fs";
import { writeAtomic } from "@rine-network/core";
import { z } from "zod";
import type { StatePaths } from "../identity/paths.js";

const Applied = z.record(z.string(), z.object({ hash: z.string().nullable(), at: z.string() }));
type AppliedMap = z.infer<typeof Applied>;

function readAll(paths: Pick<StatePaths, "appliedPolicy">): AppliedMap {
	try {
		return Applied.parse(JSON.parse(readFileSync(paths.appliedPolicy, "utf8")));
	} catch {
		return {};
	}
}

/** The last recorded apply for `repoRoot`; `null` when this repo never applied (or the record is unreadable). */
export function readApplied(paths: Pick<StatePaths, "appliedPolicy">, repoRoot: string): { hash: string | null; at: string } | null {
	return readAll(paths)[repoRoot] ?? null;
}

export function recordApplied(paths: Pick<StatePaths, "appliedPolicy">, repoRoot: string, hash: string | null, now: Date): void {
	writeAtomic(paths.appliedPolicy, `${JSON.stringify({ ...readAll(paths), [repoRoot]: { hash, at: now.toISOString() } }, null, 2)}\n`);
}

/** One line for plan and apply: how the policy file stands against the last apply. */
export function appliedLine(last: { hash: string | null; at: string } | null, current: string | null): string {
	if (last === null) return "no earlier apply of a policy in this repo";
	const day = last.at.slice(0, 10);
	if (last.hash === current) return `policy unchanged since the last apply on ${day}`;
	const short = (h: string | null) => (h === null ? "none" : h.slice(0, 8));
	return `policy changed since the last apply on ${day} (${short(last.hash)} → ${short(current)}); review \`git log -p rine-herdr.toml\``;
}
