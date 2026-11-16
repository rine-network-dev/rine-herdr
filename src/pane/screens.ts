// screens.ts — what each menu entry does. Every screen reads from the daemon or runs a CLI command and
// writes to the pane; none keeps anything between visits.
import { runApplyFromPane } from "../cli/commands/apply.js";
import { bindPane, unbindPane } from "../cli/commands/bind.js";
import { runRegisterMcp } from "../cli/commands/register.js";
import type { DaemonClient } from "../cli/daemon-client.js";
import type { CliIo } from "../cli/io.js";
import { groupHeld } from "../daemon/held-contacts.js";
import { agentOfPane } from "../daemon/registry.js";
import type { HerdrPort } from "../herdr/port.js";
import { Harness, type RegisterDeps } from "../mcp/register.js";
import { plural } from "../plural.js";
import { BASE_SKILL, installSkill, listSkills, skillSummary } from "../skills/install.js";
import { QuarantineDecision, herdrAgentName } from "../types.js";
import type { PaneStart } from "./env.js";
import {
	MENU_ENTRIES,
	type MenuScreen,
	renderBindings,
	renderQuarantine,
	renderSkills,
	renderStatus,
	senderName,
} from "./views.js";

export type Screens = Record<MenuScreen, () => Promise<void>> & {
	/** How many senders are held, for the menu's Quarantine label. */
	heldCount(): Promise<number>;
};

export function screenFor(screens: Screens, choice: string): (() => Promise<void>) | null {
	const entry = MENU_ENTRIES[Number(choice) - 1];
	return entry === undefined ? null : screens[entry.screen];
}

const DECIDED = { [QuarantineDecision.Approve]: "approved", [QuarantineDecision.Deny]: "denied" } as const;

/** A herdr agent kind as a valid agent name, or undefined when nothing usable is left of it. */
function nameFromKind(kind: string | null): string | undefined {
	const name = kind?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32);
	return name !== undefined && herdrAgentName.safeParse(name).success ? name : undefined;
}

/** `name`, or `name-2`, `name-3`... for the first one nothing in `taken` uses, so two unnamed panes never share an identity. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
	const candidate = (n: number): string => (n === 1 ? name : `${name.slice(0, 31 - String(n).length)}-${n}`);
	let n = 1;
	while (taken.has(candidate(n))) n++;
	return candidate(n);
}

export interface ScreenDeps {
	client: DaemonClient;
	port: HerdrPort;
	start: PaneStart;
	stateDir: string;
	skillsRoot: string;
	env: NodeJS.ProcessEnv;
	registerDeps: RegisterDeps;
}

type Ask = (question: string) => Promise<string | null>;

export function createScreens(deps: ScreenDeps, ask: Ask, io: CliIo): Screens {
	const { client, start } = deps;
	/** Asks for a row number; enter or the end of input is "back", anything else that is no row asks again. */
	const pick = async <T>(items: readonly T[], question: string): Promise<T | undefined> => {
		for (;;) {
			const answer = await ask(question);
			if (answer === null || answer === "") return undefined;
			const item = items[Number(answer) - 1];
			if (item !== undefined) return item;
			io.out("no such row");
		}
	};

	const bindFocused = async (): Promise<void> => {
		if (start.focusedPane === null) return io.out("No agent pane was focused when this pane opened.");
		const agent = await agentOfPane(deps.port, start.focusedPane);
		if (agent === null) return io.out("The focused pane runs no agent herdr knows.");
		let name: string | undefined;
		if (agent.name === null) {
			const kindName = nameFromKind(agent.kind);
			const taken = new Set((await client.snapshot(start.repoRoot)).map((b) => b.herdrName));
			const fallback = kindName === undefined ? undefined : freeName(kindName, taken);
			const typed = (await ask(`This agent has no herdr name. Name it${fallback ? ` [${fallback}]` : ""} (a-z, 0-9, - _): `)) ?? "";
			name = typed === "" ? (fallback ?? "") : typed;
			if (!herdrAgentName.safeParse(name).success) return io.out("That is not a valid name.");
		}
		await bindPane(client, start.focusedPane, name, io);
	};

	return {
		async bindings() {
			io.out(renderBindings(await client.snapshot(start.repoRoot), start.repoRoot));
			const action = await ask("b) bind the pane you came from  u) unbind it  enter) back > ");
			if (action === "b") await bindFocused();
			else if (action === "u" && start.focusedPane !== null) await unbindPane(client, start.focusedPane, io);
		},
		async planApply() {
			await runApplyFromPane(start.repoRoot, io, { ipc: client, stateDir: deps.stateDir });
		},
		async quarantine() {
			const contacts = groupHeld(await client.quarantineList(), await client.snapshot(start.repoRoot));
			io.out(renderQuarantine(contacts));
			const contact = contacts.length === 0 ? undefined : await pick(contacts, "Number to decide, enter) back > ");
			if (contact === undefined) return;
			const who = senderName(contact);
			const answer = await ask(`a) approve: ${who} can wake ${contact.agent} from now on   d) deny: never wake for ${who}   enter) decide later > `);
			const decision = answer === "a" ? QuarantineDecision.Approve : answer === "d" ? QuarantineDecision.Deny : null;
			if (decision === null) return io.out("Nothing decided.");
			if (decision === QuarantineDecision.Deny && !(await io.confirm(`Deny ${who}? ${contact.agent} will never be woken for them.`))) return io.out("Nothing decided.");
			io.out(`${DECIDED[decision]}: ${plural(await client.quarantineDecide(contact.bindingKey, contact.senderId, decision), "held message")} settled`);
		},
		async heldCount() {
			return groupHeld(await client.quarantineList(), []).length;
		},
		async skills() {
			const names = listSkills(deps.skillsRoot);
			io.out(renderSkills(names.map((n) => ({ name: n, summary: skillSummary(deps.skillsRoot, n), base: n === BASE_SKILL }))));
			const name = await pick(names, "Number to install, enter) back > ");
			if (name === undefined) return;
			const target = await pick(
				[
					{ harness: Harness.ClaudeCode, project: start.repoRoot },
					{ harness: Harness.ClaudeCode },
					{ harness: Harness.Codex },
				],
				"1) Claude Code, this project  2) Claude Code, user  3) Codex, user  enter) back > ",
			);
			if (target !== undefined) io.out(`installed at ${installSkill(deps.skillsRoot, name, target, deps.env)}; restart the agent in that pane to load it`);
		},
		async registration() {
			const harness = await pick(Object.values(Harness), "1) claude-code  2) codex  enter) back > ");
			if (harness !== undefined) await runRegisterMcp(["--harness", harness], io, deps.env, deps.registerDeps);
		},
		async status() {
			io.out(renderStatus(await client.status()));
		},
	};
}
