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
			// An MV3 service worker has no DOM, and neither of turndown's builds can
			// parse HTML without one:
			//   - the Node build calls `require("@mixmark-io/domino")` eagerly, and
			//     that `require` survives bundling (it sits inside an ES module, so
			//     the commonjs plugin leaves it alone) — the worker then fails to
			//     load at all with "require is not defined";
			//   - the browser build parses via `DOMParser`/`document.implementation`,
			//     which throws on the first turndown() call.
			// So: pin the browser build, which is safe to *load* (it only assigns a
			// prototype method eagerly), and hand turndown a DOM node parsed by
			// domino instead of an HTML string. See `convertArchiveHtml`.
			// Pinning it here also keeps vitest and the bundle on the same build —
			// they diverged before, which is how the failure escaped the tests.
			turndown: resolve(
				__dirname,
				"node_modules/turndown/lib/turndown.browser.es.js",
			),
			"@mixmark-io/domino": resolve(
				__dirname,
				"node_modules/@mixmark-io/domino/lib/index.js",
			),
		},
	},
	build: {
		outDir: isFirefox ? "../dist-firefox" : "../dist",
		emptyOutDir: true,
	},
});
