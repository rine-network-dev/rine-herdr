import { defineConfig } from "tsdown";

// One bin entry; bin/rine-herdr.js imports ../dist/cli.js. No declarations: the package exports no API.
export default defineConfig({
	entry: { cli: "src/cli.ts" },
	format: "esm",
	outDir: "dist",
	clean: true,
	dts: false,
});
