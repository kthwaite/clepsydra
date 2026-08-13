/**
 * Load the built service worker the way Chrome does: as an ES module, in a
 * context with no `document`, no `DOMParser`, and no CommonJS `require`.
 *
 * Unit tests cannot catch this class of failure. They import source modules,
 * while the browser loads a bundle — and the two resolved different builds of
 * turndown, so a worker that threw "require is not defined" on load still had a
 * fully green test suite.
 *
 * Usage: node scripts/verify-bundle.mjs [dist-dir]
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const distDir = resolve(process.argv[2] ?? "dist");
const workerPath = resolve(distDir, "background/service-worker.js");

const failures = [];
const listeners = [];

function listenerStub(name) {
	return { addListener: (fn) => listeners.push({ name, fn }) };
}

globalThis.chrome = {
	runtime: {
		onMessage: listenerStub("runtime.onMessage"),
		onConnect: listenerStub("runtime.onConnect"),
		getPlatformInfo: async () => ({ os: "mac" }),
		openOptionsPage: () => {},
		lastError: undefined,
	},
	action: { onClicked: listenerStub("action.onClicked") },
	commands: { onCommand: listenerStub("commands.onCommand") },
	tabs: { query: () => {}, onRemoved: listenerStub("tabs.onRemoved") },
	scripting: { executeScript: async () => [] },
	storage: { sync: { get: async () => ({}), set: async () => {} } },
	notifications: { create: () => {} },
};

// A service worker has none of these. Fail loudly if the bundle needs them.
for (const name of ["document", "DOMParser", "window", "require"]) {
	if (name in globalThis) {
		failures.push(
			`test harness leaked a global the worker will not have: ${name}`,
		);
	}
}

const source = await readFile(workerPath, "utf8");
if (/\brequire\s*\(/.test(source)) {
	failures.push(
		"bundle contains a bare require() call — it will throw " +
			'"require is not defined" the moment Chrome loads the worker',
	);
}

try {
	await import(pathToFileURL(workerPath).href);
} catch (error) {
	failures.push(`worker failed to load: ${error}`);
}

if (listeners.length === 0 && failures.length === 0) {
	failures.push(
		"worker loaded but registered no listeners — module init did not complete",
	);
}

// The content script is an IIFE for a page context, so it cannot be imported
// here — but the failure mode that bit us is textual, and so is this check.
const contentPath = resolve(distDir, "content/capture.js");
const contentSource = await readFile(contentPath, "utf8");

if (/\brequire\s*\(/.test(contentSource)) {
	failures.push(
		"content bundle contains a bare require() call — it will throw the " +
			"moment the script is injected",
	);
}

// single-file-core is ~800 KB minified. A bundle far outside that has either
// lost it or swallowed something it should not have.
const contentMb = contentSource.length / 1024 / 1024;
if (contentMb < 0.5 || contentMb > 3) {
	failures.push(
		`content bundle is ${contentMb.toFixed(2)} MB, outside the expected ` +
			"0.5–3 MB — single-file-core is missing, or something else got bundled",
	);
}

if (!contentSource.includes("saveOriginalURLs")) {
	failures.push(
		"content bundle does not mention saveOriginalURLs — without it the " +
			"server cannot join a markdown image to its stored blob",
	);
}

// `captureSnapshot` imports single-file-core dynamically (a Vitest TDZ
// workaround). If a bundler change ever emits that as a separate chunk instead
// of inlining it, the content script would try to resolve `import("./chunk-*")`
// against the PAGE's origin in the isolated world and 404 — every capture on
// every site would fail. The size check above catches the common case (an
// externalised SingleFile collapses the bundle to ~40 KB), but check directly
// too, and confirm no sibling chunk was emitted alongside it.
//
// The match requires a string/template literal argument — a real
// bundler-emitted chunk reference always looks like `import("./chunk-x.js")`,
// because Rollup can only split a specifier it can resolve statically. A bare
// `\bimport\s*\(` also matches single-file-core's zip worker bootstrap, which
// embeds `async function Ke(e){for(const t of e)await import(t)}` as literal
// *string* content (the source of a Blob it turns into a Worker) — a variable
// specifier evaluated in that worker's own scope, not a module graph gap here.
if (/\bimport\s*\(\s*["'`]/.test(contentSource)) {
	failures.push(
		"content bundle contains an unresolved dynamic import() — it will " +
			"resolve against the page origin at injection time and 404",
	);
}

const emittedChunks = (await readdir(resolve(distDir, "assets"), { withFileTypes: true }).catch(
	() => [],
)).filter((entry) => entry.isFile() && /^chunk-/.test(entry.name));
if (emittedChunks.length > 0) {
	failures.push(
		`bundler emitted ${emittedChunks.length} shared chunk(s) under assets/ ` +
			"— a content script injected by file cannot load them",
	);
}

// Task 11's frame responder. Its injection failure is swallowed on purpose — a
// frame we may not script is not a reason to abandon the page — which means a
// BUILD regression that drops this bundle would be completely invisible at
// runtime: captures would silently revert to burning a 5s timeout per iframe
// and archiving nothing from it. This is the only place that can notice.
const framesPath = resolve(distDir, "content/frames.js");
const framesSource = await readFile(framesPath, "utf8").catch(() => null);
if (framesSource === null) {
	failures.push(
		"content/frames.js is missing — iframes will silently fail to capture " +
			"and each will cost a 5s timeout",
	);
} else {
	const framesKb = framesSource.length / 1024;
	// It carries the frame-tree processor only. Measured at ~24 KB against
	// capture.js's ~840 KB; an order of magnitude either way means the import
	// graph changed.
	if (framesKb < 5 || framesKb > 200) {
		failures.push(
			`content/frames.js is ${framesKb.toFixed(0)} KB, outside the expected ` +
				"5–200 KB — the frame-tree import graph changed",
		);
	}
}

if (failures.length > 0) {
	console.error("✗ bundle verification failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(
	`✓ ${workerPath} loads with no DOM; registered ${listeners.length} listeners ` +
		`(${listeners.map((l) => l.name).join(", ")})`,
);
