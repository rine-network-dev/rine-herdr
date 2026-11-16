import { describe, expect, it } from "vitest";
import { renderBindings, renderMenu, renderQuarantine, renderSkills, renderStatus } from "../../src/pane/views.js";
import { groupHeld } from "../../src/daemon/held-contacts.js";
import { binding } from "../mcp/fixtures.js";
import { NOTICE } from "./fakes.js";

const lead = binding("applied", ["rine_whoami", "rine_send"]);

describe("pane views", () => {
	it("renders the menu on one line, with the set-up screens first and the held count when there is one", () => {
		expect(renderMenu(0)).toBe("rine  1) Bindings  2) MCP registration  3) Plan / Apply  4) Quarantine  5) Skills  6) Status  q) Quit");
		expect(renderMenu(2)).toContain("4) Quarantine (2 held)");
	});

	it("renders bindings, and an empty state that points at the pane you came from", () => {
		expect(renderBindings([lead], "/work/repo")).toMatchInlineSnapshot(`
			"Bindings in /work/repo
			  lead             repo-lead@acme.rine.network  applied  2 tools"
		`);
		expect(renderBindings([], "/work/repo")).toBe("No agents are bound in /work/repo yet. Press b to bind the pane you came from.");
	});

	it("groups held messages by agent and sender, with the count and the first arrival", () => {
		const second = { ...NOTICE, messageId: "m2", receivedAt: 5_000_000, groupHandle: "#dev@other.rine.network" };
		const other = { ...NOTICE, senderId: "other-sender", senderHandle: null };
		const contacts = groupHeld([second, NOTICE, other], [lead]);
		expect(contacts).toHaveLength(2);
		expect(contacts[0]).toMatchObject({ agent: "lead", messages: 2, firstAt: 1, groupHandle: "#dev@other.rine.network" });
		const text = renderQuarantine(contacts);
		expect(text).toMatch(/^Held first contacts \(the agent is not woken for these; it can still see them in its inbox\):\n/);
		expect(text).toMatch(/1\) bot@other\.rine\.network -> lead · 2 messages · first \d\d:\d\d via #dev@other\.rine\.network/);
		expect(text).toMatch(/2\) an unrecognised sender -> lead · 1 message · first /);
		expect(renderQuarantine([])).toBe("Nothing is held.");
	});

	it("renders status as a few plain lines, frame counters only when non-zero", () => {
		const streams = [
			{ bindingKey: "k", herdrName: "planner", paneId: "w1:p1", state: "streaming" },
			{ bindingKey: "j", herdrName: "coder", paneId: "w1:p2", state: "streaming" },
		];
		const quiet = { pid: 42, herdrConnected: true, unknownFrames: 0, droppedFrames: 0, held: 1, streams };
		expect(renderStatus(quiet)).toBe("daemon running (pid 42), connected to herdr\nagents streaming: planner, coder\nheld first contacts: 1");
		const noisy = { ...quiet, unknownFrames: 3, streams: [...streams.slice(0, 1), { bindingKey: "j", herdrName: "coder", paneId: "w1:p2", state: "failed" }] };
		expect(renderStatus(noisy)).toBe(
			"daemon running (pid 42), connected to herdr\nagents streaming: planner\n  coder (w1:p2): failed\nheld first contacts: 1\nframes: 3 unknown",
		);
	});

	it("numbers skills with their summaries and marks the base one", () => {
		expect(renderSkills([{ name: "rine-herdr", summary: "Message agents", base: true }, { name: "b", summary: "B does b", base: false }])).toBe(
			"Bundled skills:\n  1) rine-herdr (base: install this first)\n     Message agents\n  2) b\n     B does b",
		);
	});
});
