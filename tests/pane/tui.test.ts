import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PaneStart, PaneView } from "../../src/pane/env.js";
import { createScreens, freeName } from "../../src/pane/screens.js";
import { runPane } from "../../src/pane/tui.js";
import { FakePort, ok } from "../herdr/fake-port.js";
import { type fakeClient as FakeClientFn, fakeClient } from "./fakes.js";

const SKILLS = join(process.cwd(), "skills");
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "herdr-pane-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function drive(inputs: string[], opts: { client?: ReturnType<typeof FakeClientFn>; port?: FakePort; view?: PaneView } = {}) {
	const client = opts.client ?? fakeClient();
	const port = opts.port ?? new FakePort();
	const input = new PassThrough();
	const output = new PassThrough();
	const chunks: string[] = [];
	output.on("data", (c) => chunks.push(String(c)));
	const start: PaneStart = { focusedPane: "w1:p1", repoRoot: "/work/repo", view: opts.view ?? PaneView.Menu };
	input.end(`${inputs.join("\n")}\n`);
	const code = await runPane({
		input,
		output,
		start,
		screens: (ask, io) =>
			createScreens(
				{ client, port, start, stateDir: dir, skillsRoot: SKILLS, env: { HOME: dir, CODEX_HOME: join(dir, "codex") }, registerDeps: { run: async () => 0, codexConfig: join(dir, "c.toml"), out: () => {} } },
				ask,
				io,
			),
	});
	return { code, text: chunks.join(""), client, port };
}

describe("the rine pane loop", () => {
	it("shows the menu and quits on q", async () => {
		const { code, text } = await drive(["q"]);
		expect(code).toBe(0);
		expect(text).toContain("1) Bindings");
	});

	it("lets go of the input on q so the popup closes", async () => {
		const input = new PassThrough();
		input.write("q\n");
		const start: PaneStart = { focusedPane: null, repoRoot: "/work/repo", view: PaneView.Menu };
		const code = await runPane({ input, output: new PassThrough(), start, screens: () => ({ heldCount: async () => 0 }) as never });
		expect(code).toBe(0);
		expect(input.isPaused()).toBe(true);
	});

	it("labels Quarantine with how many senders are held, on one menu line", async () => {
		const { text } = await drive(["q"]);
		expect(text).toContain("4) Quarantine (1 held)");
		expect(text.split("\n").filter((l) => l.startsWith("rine  "))).toHaveLength(1);
	});

	it("asks again on a row number that does not exist", async () => {
		const { text, client } = await drive(["4", "x", "9", "1", "a", "q"]);
		expect(text.match(/no such row/g)).toHaveLength(2);
		expect(client.calls[0]).toMatch(/approve$/);
	});

	it("ends when input ends without a quit", async () => {
		expect((await drive([])).code).toBe(0);
	});

	it("rejects an unknown menu choice and carries on", async () => {
		const { text } = await drive(["9", "q"]);
		expect(text).toContain("Pick a number");
	});

	it("shows status from the daemon", async () => {
		const { text } = await drive(["6", "q"]);
		expect(text).toContain("daemon running (pid 42), connected to herdr\nagents streaming: lead\nheld first contacts: 1");
	});

	it("opens the bindings screen first when the bindings view started the pane", async () => {
		expect((await drive(["q"], { view: PaneView.Bindings })).text).toContain("Bindings in /work/repo");
	});

	it("lists bindings, then binds the focused pane under its herdr name", async () => {
		const port = new FakePort(() => ok({ agent: { pane_id: "w1:p1", workspace_id: "w1", name: "lead", agent_status: "idle" } }));
		const { client, text } = await drive(["1", "b", "q"], { port });
		expect(text).toContain("lead             repo-lead@acme.rine.network");
		expect(client.calls).toEqual(["bind w1:p1 "]);
	});

	it("offers to name an unnamed agent before binding it", async () => {
		const port = new FakePort(() => ok({ agent: { pane_id: "w1:p1", workspace_id: "w1", name: null, agent_status: "idle" } }));
		const { client, text } = await drive(["1", "b", "reviewer", "q"], { port });
		expect(text).toContain("has no herdr name");
		expect(client.calls).toEqual(["bind w1:p1 reviewer"]);
	});

	it("defaults the name of an unnamed agent to its kind", async () => {
		const port = new FakePort(() => ok({ agent: { pane_id: "w1:p1", workspace_id: "w1", name: null, agent: "claude", agent_status: "idle" } }));
		const { client, text } = await drive(["1", "b", "", "q"], { port });
		expect(text).toContain("Name it [claude] (a-z, 0-9, - _): ");
		expect(client.calls).toEqual(["bind w1:p1 claude"]);
	});

	it("offers a different default when another binding in the repo already uses the kind's name", async () => {
		const port = new FakePort(() => ok({ agent: { pane_id: "w1:p1", workspace_id: "w1", name: null, agent: "lead", agent_status: "idle" } }));
		const { client, text } = await drive(["1", "b", "", "q"], { port });
		expect(text).toContain("Name it [lead-2] (a-z, 0-9, - _): ");
		expect(client.calls).toEqual(["bind w1:p1 lead-2"]);
	});

	it("refuses an invalid name without calling the daemon", async () => {
		const port = new FakePort(() => ok({ agent: { pane_id: "w1:p1", workspace_id: "w1", name: null, agent_status: "idle" } }));
		const { client, text } = await drive(["1", "b", "Bad Name", "q"], { port });
		expect(text).toContain("not a valid name");
		expect(client.calls).toEqual([]);
	});

	it("unbinds the focused pane", async () => {
		const { client } = await drive(["1", "u", "q"]);
		expect(client.calls).toEqual(["unbind w1:p1"]);
	});

	it("approves a held first contact, naming who can wake whom, and says approved", async () => {
		const { client, text } = await drive(["4", "1", "a", "q"]);
		expect(text).toContain("it can still see them in its inbox");
		expect(text).toContain("1) bot@other.rine.network -> lead · 1 message · first ");
		expect(text).toContain("a) approve: bot can wake lead from now on   d) deny: never wake for bot   enter) decide later");
		expect(text).toContain("approved: 1 held message settled");
		expect(client.calls[0]).toMatch(/^decide 0123456789abcdef .* approve$/);
	});

	it("denies only after a yes to the confirmation, and says denied", async () => {
		const { client, text } = await drive(["4", "1", "d", "y", "q"]);
		expect(text).toContain("Deny bot? lead will never be woken for them. [y/N]");
		expect(text).toContain("denied: 1 held message settled");
		expect(client.calls[0]).toMatch(/ deny$/);
	});

	it("decides nothing on a declined deny, on enter, or on any other key", async () => {
		for (const answers of [["d", "n"], [""], ["x"], ["D"]]) {
			const { client, text } = await drive(["4", "1", ...answers, "q"]);
			expect(client.calls).toEqual([]);
			expect(text).toContain("Nothing decided.");
		}
	});

	it("installs a skill for Codex under CODEX_HOME", async () => {
		const { text } = await drive(["5", "1", "3", "q"]);
		expect(text).toContain("1) rine-herdr (base: install this first)");
		expect(text).toContain("Message other agents over rine from a herdr pane");
		expect(text).toContain("restart the agent in that pane to load it");
		expect(text).toContain(join(dir, "codex", "skills"));
		expect(existsSync(join(dir, "codex", "skills", "rine-herdr", "SKILL.md"))).toBe(true);
	});

	it("starts at the plan view when the apply action opened it, and reports an error as text", async () => {
		const { text, code } = await drive(["q"], { view: PaneView.Plan });
		expect(code).toBe(0);
		expect(text).toMatch(/error: .*(host\.json|rine-herdr init)/);
	});
});

describe("freeName", () => {
	it("keeps a free name, counts up past taken ones, and stays inside the 32-character limit", () => {
		expect(freeName("claude", new Set())).toBe("claude");
		expect(freeName("claude", new Set(["claude", "claude-2"]))).toBe("claude-3");
		const long = "a".repeat(32);
		expect(freeName(long, new Set([long]))).toBe(`${"a".repeat(30)}-2`);
	});
});
