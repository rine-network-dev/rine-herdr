import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { ACTIONS, PLUGIN_ID } from "../../src/cli/commands/action.js";
import { packageRoot } from "../../src/cli/root.js";

const ROOT = packageRoot();
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const manifest = parse(read("plugin/herdr-plugin.toml")) as {
	id: string;
	version: string;
	startup: { command: string[] }[];
	actions: { id: string; contexts: string[]; command: string[] }[];
	panes: { id: string; placement: string; command: string[] }[];
};
const pkg = JSON.parse(read("package.json")) as { version: string; name: string };
const pluginPkg = JSON.parse(read("plugin/package.json")) as { dependencies: Record<string, string> };

describe("plugin manifest", () => {
	it("carries the package version", () => {
		expect(manifest.version).toBe(pkg.version);
	});

	it("is built from an npm package that pins exactly that version", () => {
		expect(pluginPkg.dependencies[pkg.name]).toBe(pkg.version);
	});

	it("has the id the actions and the keybinding snippet use", () => {
		expect(manifest.id).toBe(PLUGIN_ID);
	});

	it("has a dispatcher for every action id, and no dispatcher without an action", () => {
		expect(manifest.actions.map((a) => a.id).sort()).toEqual(Object.keys(ACTIONS).sort());
	});

	it("runs every command through the package's own bin with the matching subcommand", () => {
		for (const action of manifest.actions) expect(action.command.at(-1)).toMatch(new RegExp(`rine-herdr\\.js" action ${action.id}$`));
		expect(manifest.startup[0]?.command.at(-1)).toMatch(/rine-herdr\.js" daemon start --detach$/);
		expect(manifest.panes[0]?.command.at(-1)).toMatch(/rine-herdr\.js" pane$/);
	});

	it("declares the popup pane the open and apply actions launch", () => {
		expect(manifest.panes.map((p) => p.id)).toEqual(["rine"]);
		expect(manifest.panes[0]?.placement).toBe("popup");
	});
});
