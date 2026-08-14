import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { executeCaptureScript as ExecuteCaptureScriptValue } from "#/lib/inject-capture";

type ExecuteCaptureScript = typeof ExecuteCaptureScriptValue;

interface Injection {
	target: { tabId: number; allFrames?: boolean };
	files: string[];
}

interface LegacyInjection {
	file: string;
	allFrames?: boolean;
}

type LegacyExecuteScript = (
	tabId: number,
	details: LegacyInjection,
	callback?: () => void,
) => unknown;

async function stubScripting(
	namespace: "browser" | "chrome" = "chrome",
	impl?: (injection: Injection) => Promise<unknown>,
) {
	const calls: Injection[] = [];
	const executeScript = vi.fn(async (injection: Injection) => {
		calls.push(injection);
		return impl ? impl(injection) : [];
	});
	const api = {
		scripting: { executeScript },
		runtime: {},
		tabs: {},
	};
	vi.stubGlobal(namespace, api);
	vi.stubGlobal(namespace === "chrome" ? "browser" : "chrome", undefined);
	// The API boundary must load only after the selected namespace is installed.
	const capture = (await import("#/lib/inject-capture")).executeCaptureScript;
	return { calls, capture };
}

async function loadLegacy(
	namespace: "browser" | "chrome",
	executeScript: LegacyExecuteScript,
	runtime: { lastError?: { message?: string } } = {},
): Promise<ExecuteCaptureScript> {
	const api = { runtime, tabs: { executeScript } };
	vi.stubGlobal(namespace, api);
	vi.stubGlobal(namespace === "chrome" ? "browser" : "chrome", undefined);
	// The API boundary must load only after the selected namespace is installed.
	return (await import("#/lib/inject-capture")).executeCaptureScript;
}

describe("executeCaptureScript", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("injects the frame responder into every frame", async () => {
		const { calls, capture } = await stubScripting();

		await capture(7);

		expect(calls[0]).toEqual({
			target: { tabId: 7, allFrames: true },
			files: ["content/frames.js"],
		});
	});

	it("injects the capture script into the top frame only", async () => {
		const { calls, capture } = await stubScripting();

		await capture(7);

		expect(calls[1]).toEqual({
			target: { tabId: 7 },
			files: ["content/capture.js"],
		});
		expect(calls[1].target.allFrames).toBeUndefined();
	});

	it("runs the responder before the capture", async () => {
		const { calls, capture } = await stubScripting();

		await capture(7);

		expect(calls.map((call) => call.files[0])).toEqual([
			"content/frames.js",
			"content/capture.js",
		]);
	});

	it("captures anyway when a frame cannot be scripted", async () => {
		const { calls, capture } = await stubScripting("chrome", async (injection) => {
			if (injection.files[0] === "content/frames.js") {
				throw new Error("Cannot access contents of the frame");
			}
			return [];
		});

		await expect(capture(7)).resolves.toBeUndefined();
		expect(calls.map((call) => call.files[0])).toContain("content/capture.js");
	});

	it("still rejects when the capture script itself cannot be injected", async () => {
		const { capture } = await stubScripting("chrome", async (injection) => {
			if (injection.files[0] === "content/capture.js") {
				throw new Error("Cannot access a chrome:// URL");
			}
			return [];
		});

		await expect(capture(7)).rejects.toThrow(/chrome:\/\//);
	});

	it("uses browser scripting when chrome is absent", async () => {
		const { calls, capture } = await stubScripting("browser");

		await capture(7);

		expect(calls).toHaveLength(2);
	});

	it("supports promise-only browser MV2 injection", async () => {
		const files: string[] = [];
		const executeScript = vi.fn(function (
			_tabId: number,
			details: LegacyInjection,
		): Promise<unknown> {
			if (arguments.length > 2) throw new TypeError("callback unsupported");
			files.push(details.file);
			return Promise.resolve([]);
		});
		const capture = await loadLegacy("browser", executeScript);

		await capture(7);

		expect(files).toEqual(["content/frames.js", "content/capture.js"]);
	});

	it("supports callback-era chrome MV2 injection", async () => {
		const files: string[] = [];
		const executeScript = vi.fn(
			(_tabId: number, details: LegacyInjection, callback?: () => void) => {
				files.push(details.file);
				queueMicrotask(() => callback?.());
			},
		);
		const capture = await loadLegacy("chrome", executeScript);

		await capture(7);

		expect(files).toEqual(["content/frames.js", "content/capture.js"]);
	});

	it("propagates callback-era runtime.lastError for the capture script", async () => {
		const runtime: { lastError?: { message?: string } } = {};
		const executeScript = vi.fn(
			(_tabId: number, details: LegacyInjection, callback?: () => void) => {
				const file = details.file;
				queueMicrotask(() => {
					runtime.lastError =
						file === "content/capture.js"
							? { message: "Cannot access this page" }
							: undefined;
					callback?.();
					runtime.lastError = undefined;
				});
			},
		);
		const capture = await loadLegacy("chrome", executeScript, runtime);

		await expect(capture(7)).rejects.toThrow("Cannot access this page");
	});
});
