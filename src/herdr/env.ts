// env.ts — what herdr puts in a plugin process, a pane and an action's context.
import { z } from "zod";

export interface HerdrEndpoint {
	/** herdr's api socket; null when the process runs outside herdr. */
	socketPath: string | null;
	binPath: string;
}

/** Plugin and pane processes share these two variables. */
export function herdrEndpoint(env: NodeJS.ProcessEnv): HerdrEndpoint {
	return {
		socketPath: env.HERDR_SOCKET_PATH || null,
		binPath: env.HERDR_BIN_PATH || "herdr",
	};
}

const PluginEnvSchema = z.object({
	HERDR_PLUGIN_ID: z.string().min(1),
	HERDR_PLUGIN_ROOT: z.string().min(1),
	HERDR_PLUGIN_CONFIG_DIR: z.string().min(1),
	HERDR_PLUGIN_STATE_DIR: z.string().min(1),
});

export interface PluginEnv {
	pluginId: string;
	pluginRoot: string;
	configDir: string;
	stateDir: string;
}

/** The plugin directories herdr sets for `[[startup]]`, actions and panes; null outside a plugin process. */
export function pluginEnv(env: NodeJS.ProcessEnv): PluginEnv | null {
	const parsed = PluginEnvSchema.safeParse(env);
	if (!parsed.success) return null;
	const v = parsed.data;
	return {
		pluginId: v.HERDR_PLUGIN_ID,
		pluginRoot: v.HERDR_PLUGIN_ROOT,
		configDir: v.HERDR_PLUGIN_CONFIG_DIR,
		stateDir: v.HERDR_PLUGIN_STATE_DIR,
	};
}

export interface PaneEnv {
	paneId: string;
	tabId: string | null;
	workspaceId: string | null;
}

/** The pane a process runs in; null outside herdr and in a popup pane, which gets no pane id. */
export function paneEnv(env: NodeJS.ProcessEnv): PaneEnv | null {
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return null;
	return {
		paneId: env.HERDR_PANE_ID,
		tabId: env.HERDR_TAB_ID || null,
		workspaceId: env.HERDR_WORKSPACE_ID || null,
	};
}

const optionalText = z.string().nullish();
const ContextSchema = z.object({
	workspace_id: optionalText,
	workspace_cwd: optionalText,
	tab_id: optionalText,
	focused_pane_id: optionalText,
	focused_pane_agent: optionalText,
	focused_pane_status: optionalText,
	focused_pane_cwd: optionalText,
	worktree: z.object({ repo_root: optionalText }).nullish(),
});

export interface ActionContext {
	workspaceId: string | null;
	workspaceCwd: string | null;
	tabId: string | null;
	focusedPaneId: string | null;
	focusedPaneAgent: string | null;
	focusedPaneStatus: string | null;
	focusedPaneCwd: string | null;
	repoRoot: string | null;
}

/** `HERDR_PLUGIN_CONTEXT_JSON` of the action that started this process; every field is null when absent. */
export function actionContext(env: NodeJS.ProcessEnv): ActionContext {
	const raw = env.HERDR_PLUGIN_CONTEXT_JSON;
	let json: unknown = {};
	if (raw) {
		try {
			json = JSON.parse(raw);
		} catch {
			throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not valid JSON");
		}
	}
	const ctx = ContextSchema.parse(json);
	return {
		workspaceId: ctx.workspace_id ?? null,
		workspaceCwd: ctx.workspace_cwd ?? null,
		tabId: ctx.tab_id ?? null,
		focusedPaneId: ctx.focused_pane_id ?? null,
		focusedPaneAgent: ctx.focused_pane_agent ?? null,
		focusedPaneStatus: ctx.focused_pane_status ?? null,
		focusedPaneCwd: ctx.focused_pane_cwd ?? null,
		repoRoot: ctx.worktree?.repo_root ?? null,
	};
}
