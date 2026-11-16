// names.ts — slugs for repos, hosts, rine agents and the host branch, clipped to the server's name regexes.
import { basename } from "node:path";
import { assertBranchName } from "@rine-network/core";

const AGENT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const REPO_SLUG_MAX = 40;
const HOST_SLUG_MAX = 20;
const ROLE_SLUG_MAX = 32;

function slugify(text: string, max: number): string {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, max)
		.replace(/-+$/, "");
}

export function repoSlug(repoRoot: string): string {
	return slugify(basename(repoRoot), REPO_SLUG_MAX) || "repo";
}

export function hostSlug(hostname: string): string {
	return slugify(hostname, HOST_SLUG_MAX) || "host";
}

export function rineAgentName(repo: string, role: string): string {
	const roleSlug = slugify(role, ROLE_SLUG_MAX);
	const name = roleSlug ? `${slugify(repo, REPO_SLUG_MAX) || "repo"}-${roleSlug}` : repoSlug(repo);
	if (!AGENT_NAME_RE.test(name)) throw new Error(`not a valid rine agent name: ${name}`);
	return name;
}

export function branchName(host: string): string {
	return assertBranchName(`herdr-${hostSlug(host)}`);
}
