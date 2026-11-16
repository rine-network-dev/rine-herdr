// init.ts — `rine-herdr init`: create or reuse this host's branch and keep its keys.
import { parseArgs } from "node:util";
import { resolveApiUrl, resolveOwnerDir } from "@rine-network/core";
import { initHost } from "../../identity/branch-init.js";
import { ownerDirAdvice } from "../../identity/clients.js";
import { resolveStateDir, statePaths } from "../../identity/paths.js";
import type { CliIo } from "../io.js";

export const INIT_USAGE =
	"rine-herdr init [--new-org --email E --org-slug S --org-name N] [--branch B] [--api-url U]";

/** The first-run order after init; the README install section lists the same commands. */
export const NEXT_STEPS = `next:
  rine-herdr link                                 let herdr load the plugin, then restart herdr (it starts the rine daemon)
  rine-herdr bind                                 in each pane that should get an agent
  rine-herdr register-mcp --harness claude-code   give that pane's agent its rine tools
  rine-herdr apply                                set the policy; then restart the agent`;

const options = {
	"new-org": { type: "boolean" },
	email: { type: "string" },
	"org-slug": { type: "string" },
	"org-name": { type: "string" },
	branch: { type: "string" },
	"api-url": { type: "string" },
} as const;

export async function runInit(argv: readonly string[], io: CliIo, stateDir = resolveStateDir()): Promise<number> {
	const { values } = parseArgs({ args: [...argv], options, strict: true });
	const email = values.email;
	const slug = values["org-slug"];
	const name = values["org-name"];
	if (values["new-org"] && !(email && slug && name)) {
		io.err(`--new-org needs --email, --org-slug and --org-name\nusage: ${INIT_USAGE}`);
		return 2;
	}
	const host = await initHost({
		paths: statePaths(stateDir),
		apiUrl: (values["api-url"] ?? resolveApiUrl()).replace(/\/$/, ""),
		branch: values.branch,
		newOrg: values["new-org"] && email && slug && name ? { email, slug, name } : undefined,
		log: io.out,
	});
	io.out(`host ready: branch ${host.branch} in org ${host.orgSlug}; branch keys are in ${stateDir}/branch-home`);
	io.err(ownerDirAdvice(resolveOwnerDir()));
	if (values["new-org"]) io.out("store the recovery phrase offline now.");
	io.out(NEXT_STEPS);
	return 0;
}
