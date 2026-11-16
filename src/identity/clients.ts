// clients.ts — HTTP clients for the three principals rine-herdr acts as: the host branch, one pane agent, the org owner.
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AuthDirs,
	HttpClient,
	PrincipalKind,
	getOrRefreshToken,
	loadOrgFromOwner,
	ownIdentityFor,
	resolveAuth,
} from "@rine-network/core";
import { AsyncRineClient } from "@rine-network/sdk";
import { type StatePaths, tilde } from "./paths.js";
import type { UnseatedTracker } from "./unseated.js";

/** A core HTTP client that signs as whatever principal `dirs` resolves to. */
export function coreHttp(dirs: AuthDirs, apiUrl: string): HttpClient {
	const auth = resolveAuth(dirs);
	if (!auth) throw new Error(`no rine identity found in ${dirs.configDir}`);
	return new HttpClient({
		apiUrl,
		tokenFn: (force = false) => getOrRefreshToken(auth.cacheDir, apiUrl, auth.signer, { force }),
		ownIdentity: ownIdentityFor(dirs.configDir, auth),
	});
}

/** The SDK client of one pane agent: it holds that agent's keys and never reads an owner dir. */
export function agentClient(configDir: string, apiUrl: string, unseated?: UnseatedTracker): AsyncRineClient {
	return new AsyncRineClient({ configDir, agentOnly: true, apiUrl, onMlsUnseated: unseated?.record });
}

/** The clients of one authority: the host branch (every command's default) or the org owner (only where the branch cannot act). */
export interface AuthorityClients {
	kind: "branch" | "owner";
	http: HttpClient;
	sdk: AsyncRineClient;
}

/** Branch authority: the host branch's own key, with the empty owner dir so no root is ever found. */
export function branchClients(paths: Pick<StatePaths, "branchHome" | "emptyOwner">, apiUrl: string): AuthorityClients {
	const dirs = { configDir: paths.branchHome, ownerDir: paths.emptyOwner };
	return { kind: "branch", http: coreHttp(dirs, apiUrl), sdk: new AsyncRineClient({ ...dirs, apiUrl }) };
}

/**
 * Owner authority for one command. Refuses unless `ownerDir` holds the root of `orgId` and the resolved
 * principal is the org itself, so a branch or agent profile can never stand in for it.
 */
export function ownerClients(opts: { configDir: string; ownerDir: string; apiUrl: string; orgId: string }): AuthorityClients {
	const { configDir, ownerDir, apiUrl, orgId } = opts;
	const dirs = { configDir, ownerDir };
	const principal = loadOrgFromOwner(ownerDir) && resolveAuth(dirs)?.signer.principal;
	if (!principal || principal.kind !== PrincipalKind.Org || principal.orgId !== orgId) {
		throw new Error(`${ownerDir} does not hold the owner keys of org ${orgId}; set RINE_OWNER_DIR to the dir that does`);
	}
	return { kind: "owner", http: coreHttp(dirs, apiUrl), sdk: new AsyncRineClient({ configDir, ownerDir, apiUrl }) };
}

/**
 * The one warning the operator gets, after the result, whenever owner authority is loaded on this host: the scrub
 * stops a pane inheriting the owner dir, not reading it, so a root left on disk here is readable by every pane process.
 */
export function ownerDirAdvice(ownerDir: string): string {
	const defaultDir = join(homedir(), ".config", "rine-owner");
	const kept = ownerDir === defaultDir ? "is the persistent default" : "sits";
	return `warning: the owner key in ${tilde(ownerDir)} ${kept} on a host that runs agents, so every pane here can read it; keep it on your own machine, or mount it only while rine-herdr apply runs.`;
}
