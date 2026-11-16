import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherScript, shellQuote, writeLauncher } from "../../src/mcp/launcher.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "herdr-launcher-"));
	mkdirSync(join(dir, "bin"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeLauncher", () => {
	it("writes an executable 0700 script that execs the cli's mcp command", () => {
		const path = writeLauncher(dir, "/opt/herdr/pkg", "/usr/bin/node");
		expect(path).toBe(join(dir, "bin", "rine-herdr-mcp"));
		expect(statSync(path).mode & 0o777).toBe(0o700);
		expect(readFileSync(path, "utf8")).toBe(
			`#!/bin/sh\nexec '/usr/bin/node' '/opt/herdr/pkg/bin/rine-herdr.js' mcp --state-dir '${dir}'\n`,
		);
	});

	it("rewrites the file for a moved install root", () => {
		writeLauncher(dir, "/old", "/usr/bin/node");
		writeLauncher(dir, "/new", "/usr/bin/node");
		expect(readFileSync(join(dir, "bin", "rine-herdr-mcp"), "utf8")).toContain("'/new/bin/rine-herdr.js'");
	});
});

describe("shellQuote", () => {
	it.each(["plain", "with space", "it's", "$(touch pwned)", "a;b", "`x`"])("round-trips %s through sh", (value) => {
		const out = spawnSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
		expect(out.stdout).toBe(value);
	});

	it("quotes every path of the script", () => {
		expect(launcherScript("/n o/node", "/r p", "/s'q")).toContain("'/n o/node' '/r p/bin/rine-herdr.js' mcp --state-dir '/s'\\''q'");
	});
});
