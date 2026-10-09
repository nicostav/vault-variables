import esbuild from "esbuild";
import { builtinModules } from "node:module";

const watch = process.argv.includes("watch");

const context = await esbuild.context({
	entryPoints: ["main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: false,
	treeShaking: true,
	outfile: "main.js",
});

if (watch) {
	await context.watch();
} else {
	await context.rebuild();
	await context.dispose();
}
