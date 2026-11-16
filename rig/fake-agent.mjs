// fake-agent.mjs: stands in for Claude Code or Codex inside a herdr pane, so the e2e needs no model.
// It must run as a process named `claude` (the e2e symlinks node under that name): `herdr agent prompt` refuses a pane whose foreground process is not a known agent.
// It reports its state to herdr, logs every line typed into it, and reaches rine through the pane's MCP
// shim exactly as a harness would. The e2e drives it through a control FIFO and reads its JSONL log.
//
//   fake /work/rig/fake-agent.mjs --name N --log N.jsonl --fifo N.ctl --shim <state>/bin/rine-herdr-mcp
//
// Control lines, one per write: `<id> state working|idle|blocked`, `<id> tools`,
// `<id> call <tool> <json arguments>`, `<id> read` (rine_read of the newest announced message).
// Every control line answers with one log record {type:"result", id, ok, ...}.
import { execFile } from "node:child_process";
import { appendFileSync, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { name: { type: "string" }, log: { type: "string" }, fifo: { type: "string" }, shim: { type: "string" } },
	strict: true,
});
const paneId = process.env.HERDR_PANE_ID;
if (!values.name || !values.log || !values.fifo || !values.shim || !paneId) {
	console.error("fake-agent: needs --name, --log, --fifo, --shim and a herdr pane (HERDR_PANE_ID)");
	process.exit(2);
}

const log = (record) => appendFileSync(values.log, `${JSON.stringify({ t: Date.now(), ...record })}\n`);

// The MCP client comes from the SDK the installed rine MCP server depends on.
const mcpRoot = join(process.env.NPM_CONFIG_PREFIX, "lib", "node_modules", "@rine-network", "mcp");
const sdkRequire = createRequire(join(mcpRoot, "package.json"));
const sdkEsm = (file) =>
	import(pathToFileURL(sdkRequire.resolve(`@modelcontextprotocol/sdk/${file}`).replace("/dist/cjs/", "/dist/esm/")).href);
const { Client } = await sdkEsm("client/index.js");
const { StdioClientTransport } = await sdkEsm("client/stdio.js");

let lastSeq = 0;
function report(state) {
	lastSeq = Math.max(lastSeq + 1, Date.now());
	return new Promise((resolve) => {
		execFile(
			"herdr",
			["pane", "report-agent", paneId, "--source", "custom:fake", "--agent", "claude", "--state", state, "--seq", String(lastSeq)],
			(error) => resolve(error === null),
		);
	});
}

/** One MCP session against the pane shim, the way a harness starts its server. */
async function withShim(use) {
	const client = new Client({ name: "fake-agent", version: "0" });
	await client.connect(new StdioClientTransport({ command: values.shim, args: [], env: { ...process.env }, stderr: "ignore" }));
	try {
		return await use(client);
	} finally {
		await client.close();
	}
}

const textOf = (result) => (result.content ?? []).map((part) => part.text ?? "").join("\n");
let newestMessageId = null;

async function control(line) {
	const [id, verb, ...rest] = line.trim().split(" ");
	try {
		switch (verb) {
			case "state":
				return log({ type: "result", id, ok: await report(rest[0]) });
			case "tools": {
				const { names, instructions } = await withShim(async (c) => ({
					names: (await c.listTools()).tools.map((tool) => tool.name),
					instructions: c.getInstructions() ?? "",
				}));
				return log({ type: "result", id, ok: true, tools: names, instructions });
			}
			case "call": {
				const [tool, ...json] = rest;
				const result = await withShim((c) => c.callTool({ name: tool, arguments: JSON.parse(json.join(" ") || "{}") }));
				return log({ type: "result", id, ok: !result.isError, text: textOf(result) });
			}
			case "read": {
				if (newestMessageId === null) return log({ type: "result", id, ok: false, text: "no announced message yet" });
				const result = await withShim((c) => c.callTool({ name: "rine_read", arguments: { message_id: newestMessageId } }));
				return log({ type: "result", id, ok: !result.isError, text: textOf(result) });
			}
			default:
				return log({ type: "result", id, ok: false, text: `unknown verb ${verb}` });
		}
	} catch (err) {
		log({ type: "result", id, ok: false, text: String(err.message ?? err) });
	}
}

createInterface({ input: process.stdin }).on("line", (text) => {
	log({ type: "line", text });
	newestMessageId = [...text.matchAll(/rine_read message_id ([0-9a-f-]{36})/g)].at(-1)?.[1] ?? newestMessageId;
});
createInterface({ input: createReadStream(values.fifo, { flags: "r+" }) }).on("line", (line) => void control(line));
process.on("SIGTERM", () => process.exit(0));

const { RINE_OWNER_DIR, RINE_TOKEN } = process.env;
log({ type: "ready", name: values.name, paneId, inherited: { RINE_OWNER_DIR, RINE_TOKEN }, reported: await report("idle") });
setInterval(() => {}, 1 << 30);
