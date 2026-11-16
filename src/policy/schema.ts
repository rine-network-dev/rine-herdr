// schema.ts — rine-herdr.toml: strict parse, so a policy typo never passes silently.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { HERDR_OPTIONAL_TOOLS } from "../tool-profiles.js";
import { FirstContact, Profile, herdrAgentName, uuid } from "../types.js";
import { closest } from "./suggest.js";

export const POLICY_FILE = "rine-herdr.toml";

const graphName = z.union([z.literal("*"), herdrAgentName]);
const role = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

const Local = z.object({ graph: z.array(z.array(graphName).min(1)).default([["*", "*"]]) }).strict();
const External = z
	.object({
		orgs: z.array(uuid).default([]),
		first_contact: z.enum(FirstContact).default(FirstContact.Approve),
		groups: z.array(z.object({ handle: z.string().min(1), agents: z.array(herdrAgentName).min(1) }).strict()).default([]),
	})
	.strict();
const Features = z.object({ tools: z.array(z.enum(HERDR_OPTIONAL_TOOLS)).default([]) }).strict();

const RawPolicy = z
	.object({
		profile: z.enum(Profile).default(Profile.Solo),
		local: Local.prefault({}),
		external: External.optional(),
		features: Features.prefault({}),
		agents: z.array(z.object({ name: herdrAgentName, role }).strict()).default([]),
	})
	.strict();

/** The tables whose keys a typo can be matched against, by their dotted path ("" is the top level). */
const TABLES: Record<string, z.ZodObject> = { "": RawPolicy, local: Local, external: External, features: Features };

/** The 1-based line a key is written on, as `key =` or a `[table.key]` header; 1 when it cannot be found. */
function lineOf(text: string, key: string): number {
	const lines = text.split("\n");
	const at = lines.findIndex((line) => {
		const t = line.trim();
		return t.startsWith(`${key} =`) || t.startsWith(`"${key}" =`) || (t.startsWith("[") && (t.includes(`[${key}]`) || t.includes(`.${key}]`)));
	});
	return at + 1 || 1;
}

function describeIssue(issue: z.ZodIssue, text: string): string[] {
	if (issue.code !== "unrecognized_keys") return [`${issue.path.join(".") || "(root)"}: ${issue.message}`];
	const known = Object.keys(TABLES[issue.path.join(".")]?.shape ?? {});
	const table = issue.path.length > 0 ? ` in [${issue.path.join(".")}]` : "";
	return issue.keys.map((key) => {
		const near = closest(key, known);
		return `line ${lineOf(text, key)}: unknown key "${key}"${table}${near ? ` (did you mean "${near}"?)` : ""}`;
	});
}

export interface PolicyFile {
	profile: Profile;
	graph: string[][];
	externalOrgs: string[];
	firstContact: FirstContact;
	externalGroups: { handle: string; agents: string[] }[];
	featureTools: string[];
	agents: { name: string; role: string }[];
	/** True when an `[external]` table is present under the solo profile, where it has no effect. */
	externalIgnored: boolean;
}

export class PolicyError extends Error {}

export function parsePolicy(text: string): PolicyFile {
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (err) {
		throw new PolicyError(`${POLICY_FILE}: ${(err as Error).message}`);
	}
	const result = RawPolicy.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.flatMap((i) => describeIssue(i, text));
		throw new PolicyError(`${POLICY_FILE} ${issues.join("; ")}`);
	}
	const p = result.data;
	return {
		profile: p.profile,
		graph: p.local.graph,
		externalOrgs: p.external?.orgs ?? [],
		firstContact: p.external?.first_contact ?? FirstContact.Approve,
		externalGroups: p.external?.groups ?? [],
		featureTools: p.features.tools,
		agents: p.agents,
		externalIgnored: p.external !== undefined && p.profile === Profile.Solo,
	};
}

/** The policy at `<repoRoot>/rine-herdr.toml`; an absent file is the solo defaults. */
export function loadPolicy(repoRoot: string): PolicyFile {
	let text: string;
	try {
		text = readFileSync(join(repoRoot, POLICY_FILE), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return parsePolicy("");
		throw err;
	}
	return parsePolicy(text);
}
