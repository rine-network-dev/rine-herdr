import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BindingStore, type PaneRef } from "../../src/identity/bindings.js";
import { bindingKey } from "../../src/identity/paths.js";
import { type Binding, BindingState } from "../../src/types.js";

function binding(repoRoot: string, herdrName: string): Binding {
	return {
		key: bindingKey(repoRoot, herdrName),
		repoRoot,
		herdrName,
		agentId: crypto.randomUUID(),
		handle: `${herdrName}@acme.rine.network`,
		configDir: `/state/agents/${herdrName}`,
		state: BindingState.PendingApply,
		tools: [],
		createdAt: "2026-11-13T10:00:00.000Z",
		appliedAt: null,
	};
}

const dir = () => mkdtempSync(join(tmpdir(), "rine-herdr-bindings-"));

describe("BindingStore", () => {
	it("round-trips bindings through the file", () => {
		const file = join(dir(), "bindings.json");
		const store = new BindingStore(file);
		const a = binding("/repo", "lead");
		store.upsert(a);
		const reopened = new BindingStore(file);
		reopened.load();
		expect(reopened.all()).toEqual([a]);
	});

	it("starts empty when the file does not exist", () => {
		const store = new BindingStore(join(dir(), "bindings.json"));
		store.load();
		expect(store.all()).toEqual([]);
	});

	it("replaces a binding with the same key on upsert", () => {
		const store = new BindingStore(join(dir(), "bindings.json"));
		const a = binding("/repo", "lead");
		store.upsert(a);
		store.upsert({ ...a, state: BindingState.Applied });
		expect(store.all().map((b) => b.state)).toEqual([BindingState.Applied]);
	});

	it("lists the bindings of one repo", () => {
		const store = new BindingStore(join(dir(), "bindings.json"));
		store.upsert(binding("/one", "lead"));
		store.upsert(binding("/two", "lead"));
		expect(store.forRepo("/one").map((b) => b.repoRoot)).toEqual(["/one"]);
	});

	it("finds the binding of a live pane through the daemon's pane map", () => {
		const store = new BindingStore(join(dir(), "bindings.json"));
		const a = binding("/repo", "lead");
		store.upsert(a);
		const panes = new Map<string, PaneRef>([["p1", { repoRoot: "/repo", herdrName: "lead" }], ["p2", { repoRoot: "/repo", herdrName: "dev" }]]);
		expect(store.byPane("p1", panes)).toEqual(a);
		expect(store.byPane("p2", panes)).toBeUndefined();
		expect(store.byPane("p3", panes)).toBeUndefined();
	});

	it("moves a corrupt file aside, logs it and starts empty", () => {
		const base = dir();
		const file = join(base, "bindings.json");
		writeFileSync(file, "{not json");
		const lines: string[] = [];
		const store = new BindingStore(file, (l) => lines.push(l), () => 1234);
		store.load();
		expect(store.all()).toEqual([]);
		expect(existsSync(file)).toBe(false);
		expect(readdirSync(base)).toContain("bindings.json.bad-1234");
		expect(lines.join("\n")).toMatch(/unreadable/);
	});

	it("moves aside a file whose rows fail the schema", () => {
		const base = dir();
		const file = join(base, "bindings.json");
		writeFileSync(file, JSON.stringify([{ key: "nope" }]));
		const store = new BindingStore(file, () => {}, () => 7);
		store.load();
		expect(store.all()).toEqual([]);
		expect(readdirSync(base)).toContain("bindings.json.bad-7");
	});

	it("rejects an invalid binding without touching the file", () => {
		const file = join(dir(), "bindings.json");
		const store = new BindingStore(file);
		expect(() => store.upsert({ ...binding("/repo", "lead"), key: "short" })).toThrow();
		expect(existsSync(file)).toBe(false);
	});
});
