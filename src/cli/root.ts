// root.ts — where the installed package lives. Source, tests and the bundled dist/cli.js sit at different
// depths, so the root is found by walking up to this package's own package.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@rine-network/herdr";

function isPackageRoot(dir: string): boolean {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PACKAGE_NAME;
	} catch {
		return false;
	}
}

export function packageRoot(from: string = fileURLToPath(import.meta.url)): string {
	let dir = dirname(from);
	while (!isPackageRoot(dir)) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`cannot find the ${PACKAGE_NAME} package root above ${from}`);
		dir = parent;
	}
	return dir;
}

export const packageVersion = (root: string): string => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

export const launcherEntry = (root: string): string => join(root, "bin", "rine-herdr.js");
export const skillsDir = (root: string): string => join(root, "skills");
