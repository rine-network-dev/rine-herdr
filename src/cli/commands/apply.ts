// apply.ts — `rine-herdr plan` and `rine-herdr apply`: show what the policy file changes, then carry it out.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveOwnerDir } from "@rine-network/core";
import { executePlan } from "../../identity/apply.js";
import { loadHost } from "../../identity/branch-init.js";
import { ownerDirAdvice } from "../../identity/clients.js";
import { type ApplyEnv, type BindingsPort, type Observation, observe } from "../../identity/observe.js";
import { resolveStateDir, statePaths } from "../../identity/paths.js";
import { describeStep } from "../../identity/step-labels.js";
import { appliedLine, readApplied, recordApplied } from "../../policy/applied.js";
import { computePlan } from "../../policy/plan.js";
import { policyProvenance } from "../../policy/provenance.js";
import { plural } from "../../plural.js";
import { POLICY_FILE } from "../../policy/schema.js";
import { type Plan, Profile } from "../../types.js";
import type { CliIo } from "../io.js";

export interface ApplyDeps {
	/** The daemon-backed bindings; the entrypoint supplies it. */
	ipc: BindingsPort;
	stateDir?: string;
}

const options = { repo: { type: "string" }, yes: { type: "boolean" }, "allow-dirty": { type: "boolean" } } as const;

interface Planned {
	obs: Observation;
	plan: Plan;
	nameOf: (k: string) => string;
	yes: boolean;
	allowDirty: boolean;
	repoRoot: string;
	ownerDir: string;
	paths: ReturnType<typeof statePaths>;
	/** The policy file differs from HEAD: nobody reviewed what is about to be applied. */
	uncommitted: boolean;
	policyHash: string | null;
}

interface Request {
	repo: string | undefined;
	yes: boolean;
	allowDirty: boolean;
}

async function gather({ repo, yes, allowDirty }: Request, io: CliIo, deps: ApplyDeps): Promise<Planned> {
	const paths = statePaths(deps.stateDir ?? resolveStateDir());
	const ownerDir = resolveOwnerDir();
	const env: ApplyEnv = { paths, host: loadHost(paths), ownerDir, ipc: deps.ipc, log: io.out };
	const repoRoot = resolve(repo ?? process.cwd());
	const obs = await observe(env, repoRoot);
	const provenance = policyProvenance(repoRoot);
	return {
		obs,
		plan: computePlan(obs.input),
		nameOf: (key) => obs.clients.bindings.get(key)?.herdrName ?? key,
		yes,
		allowDirty,
		repoRoot,
		ownerDir,
		paths,
		uncommitted: provenance.uncommitted,
		policyHash: provenance.hash,
	};
}

function request(argv: readonly string[]): Request {
	const { values } = parseArgs({ args: [...argv], options, strict: true });
	return { repo: values.repo, yes: values.yes === true, allowDirty: values["allow-dirty"] === true };
}

/** `warnUncommitted` is off when the caller has already refused the uncommitted policy in words of its own. */
function printPlan({ obs, plan, nameOf, uncommitted, paths, repoRoot, policyHash }: Planned, io: CliIo, warnUncommitted = true): void {
	if (uncommitted && warnUncommitted) {
		io.err(`warning: ${POLICY_FILE} is not committed as it stands; commit it so the policy that applies is the one reviewed`);
	}
	io.out(obs.authorityLine);
	io.out(appliedLine(readApplied(paths, repoRoot), policyHash));
	const { policy, enforced } = obs.input;
	if (policy.externalIgnored) io.out("note: [external] has no effect under the solo profile");
	const needsAllow = policy.profile !== Profile.Solo && policy.externalOrgs.length > 0;
	if (needsAllow && enforced.length === 0) {
		io.out("note: the org does not enforce external message rules, so no allow entries are needed");
	}
	if (plan.refusal) {
		io.err(`refused: ${plan.refusal}`);
		return;
	}
	if (plan.groupsNeeded > 0 && obs.input.quota === null) {
		io.out("note: the server checks the group quota when each group is created");
	}
	for (const line of plan.stuck) io.out(`note: ${line}`);
	if (plan.steps.length === 0) {
		if (plan.stuck.length === 0) io.out("nothing to do; this repo matches the policy");
		return;
	}
	const groups = plan.groupsNeeded > 0 ? ` (${plural(plan.groupsNeeded, "new group")})` : "";
	io.out(`${plural(plan.steps.length, "step")} for ${plan.repoRoot}${groups}`);
	plan.steps.forEach((step, i) => io.out(`${String(i + 1).padStart(3)}. ${describeStep(step, nameOf)}`));
}

/** Owner authority loaded on this host is the one thing worth saying after the result, so it is the last line. */
function closing({ obs, ownerDir }: Planned, code: number, io: CliIo): number {
	if (obs.clients.owner) io.err(ownerDirAdvice(ownerDir));
	return code;
}

export async function runPlan(argv: readonly string[], io: CliIo, deps: ApplyDeps): Promise<number> {
	const planned = await gather(request(argv), io, deps);
	printPlan(planned, io);
	return closing(planned, planned.plan.refusal ? 1 : 0, io);
}

/**
 * A stale group that could be neither dissolved nor left leaves the apply unfinished, whether its step failed or
 * the plan found nobody here able to take one. Nothing is recorded, so the next plan lists it again and the next
 * apply tries again (a roster that could not be read heals itself).
 */
function unfinishedStale(planned: Planned, io: CliIo): number {
	for (const line of planned.plan.stuck) io.err(`stuck: ${line}`);
	io.err("a stale group could be neither dissolved nor left (see above); the policy is not recorded as applied; run apply again once that is fixed");
	return closing(planned, 1, io);
}

async function applyPlanned(planned: Planned, io: CliIo): Promise<number> {
	const { plan, obs, nameOf, yes, paths, repoRoot, policyHash } = planned;
	const record = () => recordApplied(paths, repoRoot, policyHash, new Date());
	const unreviewed = planned.uncommitted && !planned.allowDirty;
	const blocked = unreviewed && plan.steps.length > 0 && !plan.refusal;
	if (blocked) {
		io.err(`refused: ${POLICY_FILE} is not committed; commit it, or pass --allow-dirty to apply it as it stands`);
		io.out("plan as it would run:");
	}
	printPlan(planned, io, !blocked);
	if (plan.refusal || blocked) return closing(planned, 1, io);
	if (plan.steps.length === 0) {
		if (plan.stuck.length > 0) return unfinishedStale(planned, io);
		if (!unreviewed) record();
		return closing(planned, 0, io);
	}
	if (!yes && !(await io.confirm("Apply these steps?"))) {
		io.err("Nothing changed.");
		return closing(planned, 1, io);
	}
	const result = await executePlan(plan, obs.clients);
	if (result.failure) {
		io.err(`stopped after ${plural(result.executed.length, "step")}; not run:`);
		result.remaining.forEach((step) => io.err(`  ${describeStep(step, nameOf)}`));
		return closing(planned, 1, io);
	}
	io.out(`applied ${plural(result.executed.length, "step")}`);
	if (result.stale.length > 0 || plan.stuck.length > 0) return unfinishedStale(planned, io);
	record();
	return closing(planned, 0, io);
}

export async function runApply(argv: readonly string[], io: CliIo, deps: ApplyDeps): Promise<number> {
	return applyPlanned(await gather(request(argv), io, deps), io);
}

/** The pane's apply: the popup is reachable through herdr's unauthenticated socket, so it never applies an uncommitted policy. */
export async function runApplyFromPane(repoRoot: string, io: CliIo, deps: ApplyDeps): Promise<number> {
	return applyPlanned(await gather({ repo: repoRoot, yes: false, allowDirty: false }, io, deps), io);
}
