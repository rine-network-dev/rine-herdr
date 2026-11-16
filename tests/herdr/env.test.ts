import { describe, expect, it } from "vitest";
import { actionContext, herdrEndpoint, paneEnv, pluginEnv } from "../../src/herdr/env.js";

describe("herdr env", () => {
	it("herdrEndpoint_withoutVariables_usesPathLookup", () => {
		expect(herdrEndpoint({})).toEqual({ socketPath: null, binPath: "herdr" });
		expect(herdrEndpoint({ HERDR_SOCKET_PATH: "/s", HERDR_BIN_PATH: "/b" })).toEqual({ socketPath: "/s", binPath: "/b" });
	});

	it("pluginEnv_allFourSet_returnsDirs", () => {
		const env = {
			HERDR_PLUGIN_ID: "rine",
			HERDR_PLUGIN_ROOT: "/r",
			HERDR_PLUGIN_CONFIG_DIR: "/c",
			HERDR_PLUGIN_STATE_DIR: "/s",
		};
		expect(pluginEnv(env)).toEqual({ pluginId: "rine", pluginRoot: "/r", configDir: "/c", stateDir: "/s" });
		expect(pluginEnv({ ...env, HERDR_PLUGIN_ROOT: "" })).toBeNull();
	});

	it("paneEnv_outsideHerdrOrPopup_isNull", () => {
		expect(paneEnv({})).toBeNull();
		expect(paneEnv({ HERDR_ENV: "1" })).toBeNull();
		expect(paneEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1" })).toEqual({
			paneId: "w1:p1",
			tabId: "w1:t1",
			workspaceId: null,
		});
	});

	it("actionContext_validJson_mapsFieldsAndNulls", () => {
		const json = JSON.stringify({ workspace_id: "w1", focused_pane_id: "w1:p2", worktree: { repo_root: "/repo" } });
		expect(actionContext({ HERDR_PLUGIN_CONTEXT_JSON: json })).toMatchObject({
			workspaceId: "w1",
			focusedPaneId: "w1:p2",
			repoRoot: "/repo",
			tabId: null,
		});
		expect(actionContext({}).repoRoot).toBeNull();
	});

	it("actionContext_badJson_throwsNamedError", () => {
		expect(() => actionContext({ HERDR_PLUGIN_CONTEXT_JSON: "{" })).toThrow(/not valid JSON/);
	});
});
