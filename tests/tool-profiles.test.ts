import { describe, expect, it } from "vitest";
import { HERDR_DEFAULT_TOOLS, HERDR_OPTIONAL_TOOLS, toolsFor } from "../src/tool-profiles.js";
import { Profile } from "../src/types.js";

describe("toolsFor", () => {
	it("gives solo and team the defaults", () => {
		expect(toolsFor(Profile.Solo)).toEqual([...HERDR_DEFAULT_TOOLS]);
		expect(toolsFor(Profile.Team)).toEqual([...HERDR_DEFAULT_TOOLS]);
	});

	it("adds discovery tools under open and dedupes a feature that repeats them", () => {
		const tools = toolsFor(Profile.Open, ["rine_inspect", "rine_group_roster"]);
		expect(tools).toEqual([...HERDR_DEFAULT_TOOLS, "rine_discover", "rine_inspect", "rine_group_roster"]);
	});

	it("rejects a feature outside the optional list", () => {
		expect(() => toolsFor(Profile.Solo, ["rine_funnel_create"])).toThrow(/rine_funnel_create/);
		expect(() => toolsFor(Profile.Solo, ["rine_send"])).toThrow(/rine_send/);
	});

	it("names only tools the real rine-mcp package ships", async () => {
		const { tools } = await import("@rine-network/mcp/tools");
		const shipped = new Set(tools.map((t) => t.name));
		for (const name of [...HERDR_DEFAULT_TOOLS, ...HERDR_OPTIONAL_TOOLS]) expect(shipped.has(name)).toBe(true);
	});
});
