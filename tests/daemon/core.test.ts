import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonCore, type DaemonCore } from "../../src/daemon/core.js";
import { leaseWarning } from "../../src/daemon/handlers.js";
import type { RawEvent, StreamSource } from "../../src/daemon/inbound.js";
import { bindingKey, ensureStateDirs, statePaths, type StatePaths } from "../../src/identity/paths.js";
import { provisionBinding } from "../../src/identity/provision.js";
import { type Binding, BindingState, type IpcRequest, IpcMethod, QuarantineDecision } from "../../src/types.js";
import { FakePort, ok } from "../herdr/fake-port.js";
import { AGENT_ID, HOST, SENDER_ID, uuidN } from "./fixtures.js";

vi.mock("../../src/identity/provision.js", () => ({ provisionBinding: vi.fn() }));

const PANE = "w1:p1";
let nextRequest = 1;
const req = <M extends IpcMethod>(method: M, params: Extract<IpcRequest, { method: M }>["params"]) =>
	({ id: nextRequest++, method, params }) as IpcRequest;

describe("daemon core", () => {
	let root: string;
	let repo: string;
	let paths: StatePaths;
	let port: FakePort;
	let core: DaemonCore;
	let agent: { name: string | null; status: string };
	let inbox: Map<string, RawEvent[]>;
	let started: string[];
	let logs: string[];

	const agentJson = () => ({ pane_id: PANE, workspace_id: "w1", name: agent.name, agent: "claude", cwd: repo, agent_status: agent.status });
	const status = () => core.handle(req(IpcMethod.Status, {})) as Promise<{ streams: { bindingKey: string; paneId: string | null }[]; held: number }>;
	const prompts = () => port.calling("agent", "prompt").map((c) => c[3] ?? "");

	/** A stream source whose events the test pushes per binding key. */
	const source: StreamSource = async function* (binding, signal) {
		started.push(binding.key);
		while (!signal.aborted) {
			const next = inbox.get(binding.key)?.shift();
			if (next) yield next;
			else await new Promise((r) => setTimeout(r, 2));
		}
	};
	const push = (key: string, over: Record<string, unknown> = {}) =>
		inbox.set(key, [
			...(inbox.get(key) ?? []),
			{
				type: "message",
				data: JSON.stringify({
					id: uuidN(1), conversation_id: uuidN(2), from_agent_id: SENDER_ID, type: "rine.v1.text",
					direction: "received", sender_handle: "peer@acme.rine.network", ...over,
				}),
			},
		]);

	const bound = (over: Partial<Binding> = {}): Binding => ({
		key: bindingKey(repo, "dev"),
		repoRoot: repo,
		herdrName: "dev",
		agentId: AGENT_ID,
		handle: "demo-dev@acme.rine.network",
		configDir: join(paths.agents, bindingKey(repo, "dev")),
		state: BindingState.PendingApply,
		tools: [],
		createdAt: "2026-11-13T10:00:00.000Z",
		appliedAt: null,
		...over,
	});

	const makeCore = () => {
		core = createDaemonCore({ paths, host: HOST, port, source, log: (l) => void logs.push(l), home: root, onConnection() {} });
		return core;
	};

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "rh-core-")));
		repo = join(root, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "sub"), { recursive: true });
		paths = statePaths(join(root, "state"));
		ensureStateDirs(paths);
		agent = { name: "dev", status: "idle" };
		inbox = new Map();
		started = [];
		logs = [];
		port = new FakePort((args) => {
			const [a, b] = args;
			if (a === "agent" && b === "rename") agent.name = args[3] ?? null;
			if (a === "agent" && b === "list") return ok({ agents: [agentJson()] });
			if (a === "agent") return ok({ agent: agentJson() });
			if (a === "workspace") return ok({ workspace: { workspace_id: "w1" } });
			return ok();
		});
		vi.mocked(provisionBinding).mockReset();
		vi.mocked(provisionBinding).mockImplementation(async (_p, _h, ref) => bound({ repoRoot: ref.repoRoot, herdrName: ref.herdrName }));
		makeCore();
	});
	afterEach(() => {
		core.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("bind_unnamedPane_renamesItProvisionsAndStoresAPendingBinding", async () => {
		agent.name = null;
		const reply = (await core.handle(req(IpcMethod.Bind, { paneId: PANE, name: "dev" }))) as { binding: Binding; warnings: string[] };
		expect(port.calling("agent", "rename")[0]).toEqual(["agent", "rename", PANE, "dev"]);
		expect(reply.binding).toMatchObject({ herdrName: "dev", repoRoot: repo, state: BindingState.PendingApply });
		expect(reply.warnings).toEqual([]);
		expect(JSON.parse(readFileSync(paths.bindings, "utf8"))).toHaveLength(1);
	});

	it("bind_twice_provisionsOnce", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		expect(provisionBinding).toHaveBeenCalledOnce();
	});

	it("bind_paneWithoutAnAgent_isRefused", async () => {
		port.handler = () => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: "none" } }) });
		await expect(core.handle(req(IpcMethod.Bind, { paneId: PANE }))).rejects.toThrow(/runs no agent/);
	});

	it("bind_outsideAGitRepository_isRefused", async () => {
		rmSync(join(repo, ".git"), { recursive: true });
		await expect(core.handle(req(IpcMethod.Bind, { paneId: PANE }))).rejects.toThrow(/outside a git repository/);
	});

	it("bind_paneInASubdirectory_stillResolvesTheRepoRoot", async () => {
		const sub = { ...agentJson(), cwd: join(repo, "sub") };
		port.handler = (args) => (args[0] === "workspace" ? ok({ workspace: { workspace_id: "w1" } }) : ok({ agent: sub }));
		const reply = (await core.handle(req(IpcMethod.Bind, { paneId: PANE }))) as { binding: Binding };
		expect(reply.binding.repoRoot).toBe(repo);
	});

	it("bind_foreignLiveLeaseInThePane_warnsButBinds", async () => {
		const foreign = "55555555-5555-4555-8555-555555555555";
		const body = JSON.stringify({ agentId: foreign, heartbeatAt: Date.now(), releasedAt: null });
		const lease = join(repo, ".rine", "state", "cc", "lease.json");
		mkdirSync(join(repo, ".rine", "state", "cc"), { recursive: true });
		writeFileSync(lease, `${createHash("sha256").update(body).digest("hex")}\n${body}`);
		const reply = (await core.handle(req(IpcMethod.Bind, { paneId: PANE }))) as { warnings: string[] };
		expect(reply.warnings).toEqual([leaseWarning(foreign)]);
	});

	it("forPane_boundAndUnbound_returnsTheBindingOrNull", async () => {
		await expect(core.handle(req(IpcMethod.ForPane, { paneId: PANE }))).resolves.toEqual({ binding: null });
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const reply = (await core.handle(req(IpcMethod.ForPane, { paneId: PANE }))) as { binding: Binding };
		expect(reply.binding.key).toBe(bindingKey(repo, "dev"));
	});

	it("snapshot_withAndWithoutRepo_filters", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		expect(await core.handle(req(IpcMethod.Snapshot, { repoRoot: "/elsewhere" }))).toEqual({ bindings: [] });
		const all = (await core.handle(req(IpcMethod.Snapshot, {}))) as { bindings: Binding[] };
		expect(all.bindings).toHaveLength(1);
	});

	it("markApplied_startsTheStreamAndDeliversAnInboundMessageToTheIdlePane", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await expect(core.handle(req(IpcMethod.MarkApplied, { keys: [key, "ffffffffffffffff"], tools: { [key]: ["rine_inbox"] } }))).resolves.toEqual({ updated: [key] });
		const [stored] = JSON.parse(readFileSync(paths.bindings, "utf8")) as Binding[];
		expect(stored).toMatchObject({ state: BindingState.Applied, tools: ["rine_inbox"] });
		expect((await status()).streams).toEqual([{ bindingKey: key, herdrName: "dev", paneId: PANE, state: "streaming" }]);
		push(key);
		await vi.waitFor(() => expect(prompts()).toHaveLength(1));
		expect(prompts()[0]).toContain(`rine_read message_id ${uuidN(1)}`);
	});

	it("markApplied_toolOutsideTheHerdrAllowlist_isRefusedAndTheBindingStaysPending", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await expect(core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: { [key]: ["rine_inbox", "rine_pay"] } }))).rejects.toThrow(/rine_pay/);
		const [stored] = JSON.parse(readFileSync(paths.bindings, "utf8")) as Binding[];
		expect(stored?.state).toBe(BindingState.PendingApply);
	});

	it("inbound_senderInAnAllowlistedOrg_isAnnouncedThroughTheRealWiringEvenUnderDeny", async () => {
		const orgId = "77777777-7777-4777-8777-777777777777";
		writeFileSync(join(repo, "rine-herdr.toml"), `profile = "team"\n[external]\nfirst_contact = "deny"\norgs = ["${orgId}"]\n`);
		core.close();
		core = createDaemonCore({ paths, host: HOST, port, source, log: (l) => void logs.push(l), home: root, onConnection() {}, orgLookup: async () => orgId });
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
		push(key, { sender_handle: "bot@other.rine.network" });
		await vi.waitFor(() => expect(prompts()).toHaveLength(1));
	});

	describe("group_invite frames, through the real wiring", () => {
		const SIBLING_ID = "55555555-5555-4555-8555-555555555555";
		const TEAM = 'profile = "team"\n[external]\nfirst_contact = "approve"\n';

		/** An applied binding named dev plus a sibling in the same repo, then the stream of dev is started. */
		const startWithSibling = async (toml: string, sibling: Partial<Binding> = {}) => {
			core.close();
			writeFileSync(join(repo, "rine-herdr.toml"), toml);
			const key = bindingKey(repo, "dev");
			const planner = bound({ key: bindingKey(repo, "planner"), herdrName: "planner", agentId: SIBLING_ID, state: BindingState.Applied, ...sibling });
			writeFileSync(paths.bindings, JSON.stringify([bound(), planner]));
			makeCore();
			await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
			return key;
		};
		const invite = { type: "rine.v1.group_invite", sender_handle: "planner@acme.rine.network" };

		it("inviteFromASiblingBinding_wakesNobodyAndIsNeverHeld", async () => {
			const key = await startWithSibling(TEAM);
			push(key, { ...invite, from_agent_id: SIBLING_ID });
			push(key, { id: uuidN(7), sender_handle: "peer@acme.rine.network" });
			await vi.waitFor(() => expect(prompts()).toHaveLength(1));
			expect(prompts()[0]).toContain(uuidN(7));
			expect((await status()).held).toBe(0);
		});

		it("inviteFromAStranger_isHeldAsAFirstContact", async () => {
			const key = await startWithSibling(TEAM);
			push(key, { ...invite, sender_handle: "bot@other.rine.network" });
			await vi.waitFor(async () => expect((await status()).held).toBe(1));
			expect(prompts()).toEqual([]);
		});

		it("inviteFromAnUnboundSibling_isHeldAsAFirstContact", async () => {
			const key = await startWithSibling(TEAM, { state: BindingState.Unbound });
			push(key, { ...invite, from_agent_id: SIBLING_ID, sender_handle: "planner@other.rine.network" });
			await vi.waitFor(async () => expect((await status()).held).toBe(1));
		});

		it("inviteFromASiblingUnderTheSoloProfile_isHeldBecauseSoloSeatsNoGroups", async () => {
			const key = await startWithSibling("");
			push(key, { ...invite, from_agent_id: SIBLING_ID, sender_handle: "planner@other.rine.network" });
			await vi.waitFor(async () => expect((await status()).held).toBe(1));
		});
	});

	it("unbind_stopsTheStreamClearsTheTokenAndMarksTheBindingUnbound", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
		const reply = (await core.handle(req(IpcMethod.Unbind, { paneId: PANE }))) as { binding: Binding };
		expect(reply.binding.state).toBe(BindingState.Unbound);
		expect((await status()).streams).toEqual([]);
		expect(port.calling("pane", "report-metadata").at(-1)).toContain("--clear-token");
	});

	it("bind_afterUnbind_revivesTheSameIdentityAsPending", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		await core.handle(req(IpcMethod.Unbind, { paneId: PANE }));
		const reply = (await core.handle(req(IpcMethod.Bind, { paneId: PANE }))) as { binding: Binding };
		expect(reply.binding).toMatchObject({ agentId: AGENT_ID, state: BindingState.PendingApply, appliedAt: null });
		expect(provisionBinding).toHaveBeenCalledOnce();
	});

	it("quarantineDecide_approve_typesTheHeldNoticeAndDenyDropsIt", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
		push(key, { sender_handle: "bot@other.rine.network" });
		await vi.waitFor(async () => expect((await status()).held).toBe(1));
		expect(prompts()).toEqual([]);
		const listed = (await core.handle(req(IpcMethod.QuarantineList, {}))) as { entries: unknown[] };
		expect(listed.entries).toHaveLength(1);
		await expect(core.handle(req(IpcMethod.QuarantineDecide, { bindingKey: key, senderId: SENDER_ID, decision: QuarantineDecision.Approve }))).resolves.toEqual({ settled: 1 });
		await vi.waitFor(() => expect(prompts()).toHaveLength(1));
		expect((await status()).held).toBe(0);
	});

	it("start_withAnAppliedBindingOnDisk_attachesFromTheFirstSnapshot", async () => {
		core.close();
		const key = bindingKey(repo, "dev");
		writeFileSync(paths.bindings, JSON.stringify([bound({ state: BindingState.Applied, appliedAt: "2026-11-13T10:05:00.000Z" })]));
		makeCore().start();
		await vi.waitFor(() => expect(port.sockets.some((s) => s.sent.some((l) => l.includes("session.snapshot")))).toBe(true));
		const snapshotSocket = port.sockets.find((s) => s.sent.some((l) => l.includes("session.snapshot")));
		snapshotSocket?.emit({ id: "rine:snapshot", result: { snapshot: { agents: [agentJson()] } } });
		await vi.waitFor(() => expect(started).toEqual([key]));
		expect(port.socketsSubscribedTo("pane.agent_status_changed")).toHaveLength(1);
	});

	it("statusEvent_workingThenIdle_deliversTheQueuedNoticeOnTheTransition", async () => {
		agent.status = "working";
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
		push(key);
		await vi.waitFor(() => expect(port.calling("pane", "report-metadata").length).toBeGreaterThan(0));
		expect(prompts()).toEqual([]);
		await vi.waitFor(() => expect(port.socketsSubscribedTo("pane.agent_status_changed")).toHaveLength(1));
		port.socketsSubscribedTo("pane.agent_status_changed")[0]?.emit({ event: "pane.agent_status_changed", data: { pane_id: PANE, agent_status: "idle" } });
		await vi.waitFor(() => expect(prompts()).toHaveLength(1));
	});

	it("paneClosedEvent_detachesTheBindingsStream", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
		core.start();
		await vi.waitFor(() => expect(port.socketsSubscribedTo("pane.closed")).toHaveLength(1));
		port.socketsSubscribedTo("pane.closed")[0]?.emit({ event: "pane_closed", data: { pane_id: PANE } });
		await vi.waitFor(async () => expect((await status()).streams).toEqual([]));
	});

	it("brokenPolicyFile_fallsBackToTheSoloDefaultsAndLogs", async () => {
		await core.handle(req(IpcMethod.Bind, { paneId: PANE }));
		const key = bindingKey(repo, "dev");
		writeFileSync(join(repo, "rine-herdr.toml"), "profile = [");
		await core.handle(req(IpcMethod.MarkApplied, { keys: [key], tools: {} }));
		push(key, { sender_handle: "bot@other.rine.network" });
		await vi.waitFor(async () => expect((await status()).held).toBe(1));
		expect(logs.some((l) => l.includes("policy unreadable"))).toBe(true);
	});
});
