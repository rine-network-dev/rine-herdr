// tui.ts — the rine pane: a numbered menu over a line reader. It holds no state; every screen asks the
// daemon again. Input and output are injected, so the loop runs under a PassThrough in tests.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CliIo } from "../cli/io.js";
import { PaneView, type PaneStart } from "./env.js";
import { type Screens, screenFor } from "./screens.js";
import { MenuScreen, menuKey, renderMenu } from "./views.js";

const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export interface PaneLoopOptions {
	input: Readable;
	output: Writable;
	start: PaneStart;
	/** Builds the screens over the line reader; the entrypoint supplies the real ones. */
	screens(ask: (question: string) => Promise<string | null>, io: CliIo): Screens;
}

/** Runs until the user quits or input ends, then lets go of the input so the popup closes. Returns 0. */
export async function runPane(opts: PaneLoopOptions): Promise<number> {
	const reader = createInterface({ input: opts.input });
	try {
		return await loop(opts, reader);
	} finally {
		reader.close();
	}
}

async function loop(opts: PaneLoopOptions, reader: ReturnType<typeof createInterface>): Promise<number> {
	const lines = reader[Symbol.asyncIterator]();
	const ask = async (question: string): Promise<string | null> => {
		opts.output.write(question);
		const next = await lines.next();
		return next.done ? null : next.value.trim();
	};
	const write = (line: string): void => void opts.output.write(`${line}\n`);
	const io: CliIo = {
		out: write,
		err: write,
		confirm: async (question) => /^y(es)?$/i.test((await ask(`${question} [y/N] `)) ?? ""),
	};
	const clear = (): void => void ((opts.output as { isTTY?: boolean }).isTTY && opts.output.write(CLEAR_SCREEN));
	const screens = opts.screens(ask, io);
	const first = { [PaneView.Menu]: "", [PaneView.Plan]: menuKey(MenuScreen.PlanApply), [PaneView.Bindings]: menuKey(MenuScreen.Bindings) };
	let choice: string | null = first[opts.start.view];
	clear();
	for (;;) {
		if (choice === "") {
			write(renderMenu(await screens.heldCount().catch(() => 0)));
			choice = await ask("> ");
		}
		if (choice === null || choice === "q") return 0;
		const screen = screenFor(screens, choice);
		if (screen === null) write("Pick a number from the menu, or q to quit.");
		else {
			clear();
			try {
				await screen();
			} catch (err) {
				write(`error: ${(err as Error).message}`);
			}
		}
		choice = "";
	}
}
