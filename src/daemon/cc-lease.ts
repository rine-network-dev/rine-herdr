// cc-lease.ts — defers to the Claude Code plugin when it already delivers for this agent. The plugin holds
// a sealed lease file (`sha256hex(body) + "\n" + body`, the plugin's own envelope.ts `open`) and renews it
// every 10 s; a lease for our agent that is unreleased and fresh means the plugin wakes the session.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LEASE_TTL_MS = 30_000;
const LEASE_FILE = ["state", "cc", "lease.json"] as const;

const LeaseBody = z.object({
	agentId: z.string(),
	heartbeatAt: z.number(),
	releasedAt: z.number().nullable(),
});

export interface LeaseVerdict {
	/** True when the plugin delivers for this agent: the daemon types nothing. */
	defer: boolean;
	/** A live lease held for a different agent, which does not defer but is worth a warning at bind. */
	foreignAgentId: string | null;
}

/** The plugin's resolution order: the user-level dir, then the project's own `.rine`. */
export function leasePaths(home: string, cwd: string | null): string[] {
	const paths = [join(home, ".config", "rine", ...LEASE_FILE)];
	if (cwd !== null) paths.push(join(cwd, ".rine", ...LEASE_FILE));
	return paths;
}

function openSealed(text: string): unknown {
	const cut = text.indexOf("\n");
	if (cut < 0) return undefined;
	const body = text.slice(cut + 1);
	if (text.slice(0, cut) !== createHash("sha256").update(body).digest("hex")) return undefined;
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

type Read = { text: string; mtimeMs: number } | null;

function readLease(path: string): Read {
	try {
		return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
	} catch {
		return null;
	}
}

export function leaseVerdict(agentId: string, home: string, cwd: string | null, now: number): LeaseVerdict {
	let foreignAgentId: string | null = null;
	for (const path of leasePaths(home, cwd)) {
		const file = readLease(path);
		if (file === null) continue;
		const body = LeaseBody.safeParse(openSealed(file.text));
		// A lease that exists but cannot be read counts as held for 30 s from its mtime.
		if (!body.success) {
			if (now - file.mtimeMs < LEASE_TTL_MS) return { defer: true, foreignAgentId };
			continue;
		}
		const live = body.data.releasedAt === null && now - body.data.heartbeatAt < LEASE_TTL_MS;
		if (!live) continue;
		if (body.data.agentId === agentId) return { defer: true, foreignAgentId };
		foreignAgentId = body.data.agentId;
	}
	return { defer: false, foreignAgentId };
}
