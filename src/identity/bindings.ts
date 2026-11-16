// bindings.ts — the pane → rine agent bindings the daemon owns. Atomic writes, schema-checked reads;
// a corrupt file is set aside and the daemon starts empty, because a bad file must never stop it booting.
import { readFileSync, renameSync } from "node:fs";
import { writeAtomic } from "@rine-network/core";
import { z } from "zod";
import { type Binding, BindingSchema } from "../types.js";
import { bindingKey } from "./paths.js";

/** Where a pane lives: the repo it works in and the name herdr gives its agent. */
export interface PaneRef {
	repoRoot: string;
	herdrName: string;
}

const BindingList = z.array(BindingSchema);

export class BindingStore {
	private bindings = new Map<string, Binding>();

	constructor(
		private readonly file: string,
		private readonly log: (line: string) => void = () => {},
		private readonly now: () => number = Date.now,
	) {}

	/** Read the file. A missing file is an empty store; a corrupt one is renamed to `<file>.bad-<ts>`. */
	load(): void {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		let parsed: Binding[];
		try {
			parsed = BindingList.parse(JSON.parse(text));
		} catch (err) {
			const aside = `${this.file}.bad-${this.now()}`;
			renameSync(this.file, aside);
			this.log(`bindings file was unreadable (${(err as Error).message}); moved to ${aside}, starting empty`);
			return;
		}
		this.bindings = new Map(parsed.map((b) => [b.key, b]));
	}

	all(): readonly Binding[] {
		return [...this.bindings.values()];
	}

	forRepo(repoRoot: string): Binding[] {
		return this.all().filter((b) => b.repoRoot === repoRoot);
	}

	/** The binding of a live pane, given the daemon's current pane map; undefined when the pane is not bound. */
	byPane(paneId: string, panes: ReadonlyMap<string, PaneRef>): Binding | undefined {
		const pane = panes.get(paneId);
		return pane && this.bindings.get(bindingKey(pane.repoRoot, pane.herdrName));
	}

	upsert(binding: Binding): void {
		const next = new Map(this.bindings).set(binding.key, BindingSchema.parse(binding));
		writeAtomic(this.file, `${JSON.stringify([...next.values()], null, 2)}\n`);
		this.bindings = next;
	}
}
