import { resolve } from "node:path";
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

const target = process.env.TARGET || "chrome";
const isFirefox = target === "firefox";

export default defineConfig({
	root: "src",
	plugins: [
		webExtension({
			manifest: isFirefox ? "../manifest.v2.json" : "../manifest.json",
			browser: target,
			additionalInputs: ["content/capture.ts", "public/icons/icon-128.png"],
		}),
	],
	resolve: {
		alias: {
			"#": resolve(__dirname, "src"),
		},
	},
	build: {
		outDir: isFirefox ? "../dist-firefox" : "../dist",
		emptyOutDir: true,
	},
});
