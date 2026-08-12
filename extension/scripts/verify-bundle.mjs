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

import { readFile } from "node:fs/promises";
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
		getPlatformInfo: async () => ({ os: "mac" }),
		openOptionsPage: () => {},
		lastError: undefined,
	},
	action: { onClicked: listenerStub("action.onClicked") },
	commands: { onCommand: listenerStub("commands.onCommand") },
	tabs: { query: () => {} },
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

if (failures.length > 0) {
	console.error("✗ bundle verification failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(
	`✓ ${workerPath} loads with no DOM; registered ${listeners.length} listeners ` +
		`(${listeners.map((l) => l.name).join(", ")})`,
);
