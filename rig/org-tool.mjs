// org-tool.mjs: the rine side of the e2e that herdr never touches. It plays the second org and reads the
// first org's server state as its owner. Every verb prints one JSON document. Runs inside the rig only.
//
//   org-tool.mjs register <label> <email-domain>         new org; keys under /work/scratch/<label>
//   org-tool.mjs agent <label> <name>                    owner creates an agent
//   org-tool.mjs branches <owner-dir> <config-dir>       branch names of the owner's org
//   org-tool.mjs agents <owner-dir> <config-dir>         agents with their policies and exposure presets
//   org-tool.mjs groups <agent-config-dir>               groups the agent belongs to
//   org-tool.mjs group-create <agent-config-dir> <name> <member-agent-id>
//   org-tool.mjs send <agent-config-dir> <to> <text>
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API = process.env.RINE_API_URL;
const modules = join(process.env.NPM_CONFIG_PREFIX, "lib", "node_modules", "@rine-network");
const load = (pkg) => import(pathToFileURL(join(modules, pkg, "dist", "index.js")).href);
const [core, sdk] = await Promise.all([load("core"), load("sdk")]);

const [verb, ...args] = process.argv.slice(2);
const dirs = (label) => ({ configDir: `/work/scratch/${label}/cfg`, ownerDir: `/work/scratch/${label}/owner` });
const owner = (ownerDir, configDir) => new sdk.AsyncRineClient({ configDir, ownerDir, apiUrl: API });
const agentOnly = (configDir) => new sdk.AsyncRineClient({ configDir, agentOnly: true, apiUrl: API });
const out = (value) => console.log(JSON.stringify(value));
const rowsOf = (page) => (Array.isArray(page) ? page : page.items);

function ownerHttp(ownerDir, configDir) {
	const auth = core.resolveAuth({ configDir, ownerDir });
	return new core.HttpClient({
		apiUrl: API,
		tokenFn: (force = false) => core.getOrRefreshToken(auth.cacheDir, API, auth.signer, { force }),
		ownIdentity: core.ownIdentityFor(configDir, auth),
	});
}

switch (verb) {
	case "register": {
		const [label, domain] = args;
		const stamp = Date.now();
		const slug = `${label}${String(stamp).slice(-7)}`;
		const registered = await sdk.register({
			apiUrl: API,
			...dirs(label),
			email: `e2e-${label}-${stamp}@${domain}`,
			slug,
			name: label,
		});
		out({ orgId: registered.orgId, slug });
		break;
	}
	case "agent": {
		const [label, name] = args;
		const agent = await owner(dirs(label).ownerDir, dirs(label).configDir).createAgent(name);
		out({ id: agent.id, handle: agent.handle });
		break;
	}
	case "branches": {
		const listed = await ownerHttp(args[0], args[1]).get("/orgs/me/branches");
		out(listed.branches.map((b) => b.name));
		break;
	}
	case "agents": {
		const [ownerDir, configDir] = args;
		const client = owner(ownerDir, configDir);
		const http = ownerHttp(ownerDir, configDir);
		const rows = [];
		for (const agent of rowsOf(await client.listAgents())) {
			const view = await core.getExposure(http, agent.id);
			rows.push({
				id: agent.id,
				name: agent.name,
				handle: agent.handle,
				incoming: agent.incoming_policy,
				outgoing: agent.outgoing_policy,
				preset: view.preset,
			});
		}
		out(rows);
		break;
	}
	case "groups": {
		const listed = await agentOnly(args[0]).groups.list();
		out(rowsOf(listed).map((g) => ({ id: g.id, name: g.name, handle: g.handle, enrollment: g.enrollment_policy })));
		break;
	}
	case "group-create": {
		const [configDir, name, member] = args;
		const created = await agentOnly(configDir).groups.create(name, {
			visibility: "private",
			enrollment: "closed",
			members: [sdk.asAgentUuid(member)],
		});
		out({ id: created.id, handle: created.handle });
		break;
	}
	case "send": {
		const [configDir, to, text] = args;
		const sent = await agentOnly(configDir).send(to, { text });
		out({ id: sent.id });
		break;
	}
	default:
		console.error("org-tool: unknown verb");
		process.exit(2);
}
