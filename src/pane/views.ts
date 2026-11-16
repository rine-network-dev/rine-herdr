// views.ts — the rine pane's screens as plain strings. Each takes a snapshot of daemon state and renders it;
// nothing here reads or writes anything, so the pane keeps no state of its own.
import type { HeldContact } from "../daemon/held-contacts.js";
import { StreamState } from "../daemon/inbound.js";
import { tilde } from "../identity/paths.js";
import { plural } from "../plural.js";
import type { Binding } from "../types.js";

export interface StatusSnapshot {
	pid: number;
	herdrConnected: boolean;
	unknownFrames: number;
	droppedFrames: number;
	held: number;
	streams: readonly { bindingKey: string; herdrName: string; paneId: string | null; state: string }[];
}

export const MenuScreen = {
	Bindings: "bindings",
	Registration: "registration",
	PlanApply: "planApply",
	Quarantine: "quarantine",
	Skills: "skills",
	Status: "status",
} as const;
export type MenuScreen = (typeof MenuScreen)[keyof typeof MenuScreen];

/** In menu order: setting up an agent (bind, register, apply) comes before looking after one. */
export const MENU_ENTRIES: readonly { screen: MenuScreen; label: string }[] = [
	{ screen: MenuScreen.Bindings, label: "Bindings" },
	{ screen: MenuScreen.Registration, label: "MCP registration" },
	{ screen: MenuScreen.PlanApply, label: "Plan / Apply" },
	{ screen: MenuScreen.Quarantine, label: "Quarantine" },
	{ screen: MenuScreen.Skills, label: "Skills" },
	{ screen: MenuScreen.Status, label: "Status" },
];

/** The number a menu screen is picked with. */
export const menuKey = (screen: MenuScreen): string => String(MENU_ENTRIES.findIndex((e) => e.screen === screen) + 1);

export function renderMenu(held: number): string {
	const entries = MENU_ENTRIES.map((e, i) => `${i + 1}) ${e.label}${e.screen === MenuScreen.Quarantine && held > 0 ? ` (${held} held)` : ""}`);
	return `rine  ${[...entries, "q) Quit"].join("  ")}`;
}

export function renderBindings(bindings: readonly Binding[], repoRoot: string): string {
	const where = tilde(repoRoot);
	if (bindings.length === 0) return `No agents are bound in ${where} yet. Press b to bind the pane you came from.`;
	const rows = bindings.map((b) => `  ${b.herdrName.padEnd(16)} ${b.handle}  ${b.state}  ${b.tools.length} tools`);
	return [`Bindings in ${where}`, ...rows].join("\n");
}

/** The sender's name as the decision prompt says it: the handle's local part. */
export const senderName = (c: HeldContact): string => c.senderHandle?.split("@")[0] ?? "this sender";

export function renderQuarantine(contacts: readonly HeldContact[]): string {
	if (contacts.length === 0) return "Nothing is held.";
	const rows = contacts.map((c, i) => {
		const count = plural(c.messages, "message");
		const first = new Date(c.firstAt).toTimeString().slice(0, 5);
		const via = c.groupHandle ? ` via ${c.groupHandle}` : "";
		return `  ${i + 1}) ${c.senderHandle ?? "an unrecognised sender"} -> ${c.agent} · ${count} · first ${first}${via}`;
	});
	return ["Held first contacts (the agent is not woken for these; it can still see them in its inbox):", ...rows].join("\n");
}

export function renderStatus(status: StatusSnapshot): string {
	const streaming = status.streams.filter((s) => s.state === StreamState.Streaming).map((s) => s.herdrName);
	const stopped = status.streams.filter((s) => s.state !== StreamState.Streaming).map((s) => `  ${s.herdrName} (${s.paneId ?? "no pane"}): ${s.state}`);
	const frames = [
		...(status.unknownFrames > 0 ? [`${status.unknownFrames} unknown`] : []),
		...(status.droppedFrames > 0 ? [`${status.droppedFrames} dropped`] : []),
	];
	return [
		`daemon running (pid ${status.pid}), ${status.herdrConnected ? "connected to herdr" : "not connected to herdr"}`,
		`agents streaming: ${streaming.length > 0 ? streaming.join(", ") : "none"}`,
		...stopped,
		`held first contacts: ${status.held}`,
		...(frames.length > 0 ? [`frames: ${frames.join(", ")}`] : []),
	].join("\n");
}

export interface SkillRow {
	name: string;
	summary: string;
	base: boolean;
}

export function renderSkills(skills: readonly SkillRow[]): string {
	const rows = skills.flatMap((s, i) => [`  ${i + 1}) ${s.name}${s.base ? " (base: install this first)" : ""}`, `     ${s.summary}`]);
	return ["Bundled skills:", ...rows].join("\n");
}
