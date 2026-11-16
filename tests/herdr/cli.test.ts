import { describe, expect, it } from "vitest";
import {
	agentGet,
	agentList,
	agentRename,
	clearToken,
	HerdrCliError,
	HerdrSound,
	notify,
	openPane,
	promptAgent,
	reportToken,
	reportWorkspaceToken,
	workspaceGet,
} from "../../src/herdr/cli.js";
import { AgentStatus } from "../../src/types.js";
import { fail, FakePort, ok } from "./fake-port.js";

const agent = { pane_id: "w1:p1", workspace_id: "w1", name: "dev", agent: "claude", cwd: "/repo", agent_status: "idle" };

describe("herdr cli wrappers", () => {
	it("promptAgent_blockedReply_returnsBlockedNotException", async () => {
		const port = new FakePort(() => fail("agent_blocked", "agent dev is blocked"));
		await expect(promptAgent(port, "w1:p1", "hi")).resolves.toEqual({ blocked: true });
	});

	it("promptAgent_otherFailure_carriesTheError", async () => {
		const port = new FakePort(() => fail("pane_not_found"));
		await expect(promptAgent(port, "w1:p1", "hi")).resolves.toMatchObject({ blocked: false, error: { code: "pane_not_found" } });
	});

	it("promptAgent_success_passesTextAsOneArgument", async () => {
		const port = new FakePort();
		await expect(promptAgent(port, "w1:p1", "rine: a b; $(x)")).resolves.toEqual({ blocked: false, error: null });
		expect(port.calls[0]).toEqual(["agent", "prompt", "w1:p1", "rine: a b; $(x)"]);
	});

	it("reportToken_longValue_clippedTo80CodePoints", async () => {
		const port = new FakePort();
		await reportToken(port, "w1:p1", "✉".repeat(200));
		const arg = port.calls[0]?.at(-1) ?? "";
		expect(arg.startsWith("rine=")).toBe(true);
		expect(Array.from(arg.slice("rine=".length))).toHaveLength(80);
	});

	it("clearToken_callsClearTokenForTheRineToken", async () => {
		const port = new FakePort();
		await clearToken(port, "w1:p1");
		expect(port.calls[0]).toEqual(["pane", "report-metadata", "w1:p1", "--source", "custom:rine", "--clear-token", "rine"]);
	});

	it("reportWorkspaceToken_targetsTheWorkspace", async () => {
		const port = new FakePort();
		await reportWorkspaceToken(port, "w1", "✉2");
		expect(port.calls[0]?.slice(0, 3)).toEqual(["workspace", "report-metadata", "w1"]);
	});

	it("notify_longTitleAndBody_clippedTo80And240", async () => {
		const port = new FakePort();
		await notify(port, { title: "t".repeat(300), body: "b".repeat(500), sound: HerdrSound.Request });
		const call = port.calls[0] ?? [];
		expect(call[2]).toHaveLength(80);
		expect(call[call.indexOf("--body") + 1]).toHaveLength(240);
		expect(call[call.indexOf("--sound") + 1]).toBe("request");
	});

	it("agentGet_parsesAgentInfo", async () => {
		const port = new FakePort(() => ok({ agent, type: "agent_info" }));
		await expect(agentGet(port, "w1:p1")).resolves.toEqual({
			paneId: "w1:p1",
			workspaceId: "w1",
			name: "dev",
			kind: "claude",
			cwd: "/repo",
			status: AgentStatus.Idle,
		});
	});

	it("agentList_unknownStatus_mapsToUnknown", async () => {
		const port = new FakePort(() => ok({ agents: [{ ...agent, agent_status: "sleeping", name: null }] }));
		const [first] = await agentList(port);
		expect(first).toMatchObject({ status: AgentStatus.Unknown, name: null });
	});

	it("agentRename_passesTargetAndName", async () => {
		const port = new FakePort(() => ok({ agent }));
		await agentRename(port, "w1:p1", "dev");
		expect(port.calls[0]).toEqual(["agent", "rename", "w1:p1", "dev"]);
	});

	it("workspaceGet_worktreeRepoRoot_isReturned", async () => {
		const port = new FakePort(() => ok({ workspace: { workspace_id: "w1", worktree: { repo_root: "/repo" } } }));
		await expect(workspaceGet(port, "w1")).resolves.toEqual({ workspaceId: "w1", repoRoot: "/repo" });
		port.handler = () => ok({ workspace: { workspace_id: "w1" } });
		await expect(workspaceGet(port, "w1")).resolves.toEqual({ workspaceId: "w1", repoRoot: null });
	});

	it("openPane_buildsPluginPaneOpenArgs", async () => {
		const port = new FakePort();
		await openPane(port, { plugin: "rine", entrypoint: "rine-pane", cwd: "/repo", env: { A: "1" } });
		expect(port.calls[0]).toEqual([
			"plugin", "pane", "open", "--plugin", "rine", "--entrypoint", "rine-pane", "--cwd", "/repo", "--env", "A=1",
		]);
	});

	it("reportToken_cliFailure_throwsHerdrCliErrorWithCode", async () => {
		const port = new FakePort(() => fail("pane_not_found"));
		await expect(reportToken(port, "w1:p9", "x")).rejects.toMatchObject({ code: "pane_not_found" });
		await expect(reportToken(port, "w1:p9", "x")).rejects.toBeInstanceOf(HerdrCliError);
	});

	it("reportToken_exitZeroWithNoOutput_isSuccess", async () => {
		const port = new FakePort(() => ({ code: 0, stdout: "", stderr: "" }));
		await expect(reportToken(port, "w1:p1", "x")).resolves.toBeUndefined();
		await expect(clearToken(port, "w1:p1")).resolves.toBeUndefined();
	});

	it("call_garbageOutput_throwsCliFailed", async () => {
		const port = new FakePort(() => ({ code: 2, stdout: "", stderr: "boom" }));
		await expect(clearToken(port, "w1:p1")).rejects.toMatchObject({ code: "cli_failed" });
	});
});
