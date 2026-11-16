// branch-init.ts — `rine-herdr init`: publish this host's branch and keep only the branch keys.
// The org root stays in the owner dir; nothing here copies root.key, the phrase or the org profile.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import {
	DEFAULT_PROFILE,
	PrincipalKind,
	RineApiError,
	addProfileIfAbsent,
	assertBranchName,
	createBranch,
	deriveBranch,
	loadOrgFromOwner,
	principalString,
	resolveOwnerDir,
	saveBranchSecrets,
	writeAtomic,
} from "@rine-network/core";
import { register } from "@rine-network/sdk";
import { branchName, hostSlug } from "./names.js";
import { ownerClients } from "./clients.js";
import { type StatePaths, ensureStateDirs } from "./paths.js";
import { type Host, HostSchema } from "../types.js";

const CONFLICT = 409;

export interface InitOptions {
	paths: StatePaths;
	apiUrl: string;
	ownerDir?: string;
	hostname?: string;
	/** Branch name override; the default is `herdr-<host slug>`. */
	branch?: string;
	/** Register a fresh org into `ownerDir`, which must be empty or absent. */
	newOrg?: { email: string; slug: string; name: string };
	log?: (line: string) => void;
}

function assertEmptyOwnerDir(ownerDir: string): void {
	if (existsSync(ownerDir) && readdirSync(ownerDir).length > 0) {
		throw new Error(`${ownerDir} is not empty; --new-org registers into an empty directory only`);
	}
}

export function loadHost(paths: StatePaths): Host {
	try {
		return HostSchema.parse(JSON.parse(readFileSync(paths.host, "utf8")));
	} catch (err) {
		throw new Error(`no usable ${paths.host} (${(err as Error).message}); run \`rine-herdr init\` first`);
	}
}

export async function initHost(opts: InitOptions): Promise<Host> {
	const { paths, apiUrl, log = () => {} } = opts;
	const ownerDir = opts.ownerDir ?? resolveOwnerDir();
	ensureStateDirs(paths);
	if (opts.newOrg) {
		assertEmptyOwnerDir(ownerDir);
		const created = await register({ apiUrl, configDir: paths.branchHome, ownerDir, ...opts.newOrg });
		log(`registered org ${created.orgId}; the recovery phrase is at ${created.phrasePath}`);
	}
	const org = loadOrgFromOwner(ownerDir);
	if (!org) throw new Error(`no org root in ${ownerDir}; set RINE_OWNER_DIR to your owner dir, or pass --new-org`);

	const slug = hostSlug(opts.hostname ?? osHostname());
	const name = opts.branch ? assertBranchName(opts.branch) : branchName(slug);
	const owner = ownerClients({ configDir: paths.branchHome, ownerDir, apiUrl, orgId: org.orgId });
	const branch = deriveBranch(org, name);
	try {
		await createBranch(owner.http, org, branch);
		log(`created branch ${name}`);
	} catch (err) {
		if (!(err instanceof RineApiError) || err.status !== CONFLICT) throw err;
		log(`branch ${name} already exists; reusing its derived keys`);
	}
	saveBranchSecrets(paths.branchHome, branch);
	addProfileIfAbsent(paths.branchHome, DEFAULT_PROFILE, {
		org_id: org.orgId,
		principal: principalString({ kind: PrincipalKind.Branch, orgId: org.orgId, name }),
		branch: name,
	});

	const orgSlug = (await owner.sdk.whoami()).org.slug;
	if (!orgSlug) throw new Error(`org ${org.orgId} has no slug; the daemon needs it to tell same-org senders`);
	const host = HostSchema.parse({ branch: name, orgId: org.orgId, orgSlug, apiUrl, hostSlug: slug });
	writeAtomic(paths.host, `${JSON.stringify(host, null, 2)}\n`);
	return host;
}
