// env.ts — what the action that opens the rine pane tells it: the pane that was focused, the repo, and the
// view to start in. herdr gives a popup no pane id of its own, so these travel as plugin-pane env.
import { findRepoRoot } from "../daemon/registry.js";

export const PaneVar = { Focused: "RINE_HERDR_FOCUSED_PANE", Repo: "RINE_HERDR_REPO", View: "RINE_HERDR_VIEW" } as const;

export const PaneView = { Menu: "menu", Bindings: "bindings", Plan: "plan" } as const;
export type PaneView = (typeof PaneView)[keyof typeof PaneView];

export interface PaneStart {
	focusedPane: string | null;
	repoRoot: string;
	view: PaneView;
}

export function paneStart(env: NodeJS.ProcessEnv, cwd: string): PaneStart {
	return {
		focusedPane: env[PaneVar.Focused] || null,
		repoRoot: env[PaneVar.Repo] || findRepoRoot(cwd) || cwd,
		view: Object.values(PaneView).find((v) => v === env[PaneVar.View]) ?? PaneView.Menu,
	};
}

export function paneLaunchEnv(start: { focusedPane: string | null; repoRoot: string | null; view: PaneView }): Record<string, string> {
	return {
		[PaneVar.View]: start.view,
		...(start.focusedPane ? { [PaneVar.Focused]: start.focusedPane } : {}),
		...(start.repoRoot ? { [PaneVar.Repo]: start.repoRoot } : {}),
	};
}
