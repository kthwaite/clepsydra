import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeCaptureScript } from "#/lib/inject-capture";

interface Injection {
	target: { tabId: number; allFrames?: boolean };
	files: string[];
}

function stubScripting(impl?: (injection: Injection) => Promise<unknown>) {
	const calls: Injection[] = [];
	const executeScript = vi.fn(async (injection: Injection) => {
		calls.push(injection);
		return impl ? impl(injection) : [];
	});
	vi.stubGlobal("chrome", {
		scripting: { executeScript },
		runtime: {},
		tabs: {},
	});
	return calls;
}

describe("executeCaptureScript", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("injects the frame responder into every frame", async () => {
		const calls = stubScripting();

		await executeCaptureScript(7);

		expect(calls[0]).toEqual({
			target: { tabId: 7, allFrames: true },
			files: ["content/frames.js"],
		});
	});

	it("injects the capture script into the top frame only", async () => {
		const calls = stubScripting();

		await executeCaptureScript(7);

		expect(calls[1]).toEqual({
			target: { tabId: 7 },
			files: ["content/capture.js"],
		});
		expect(calls[1].target.allFrames).toBeUndefined();
	});

	it("runs the responder before the capture", async () => {
		// The responders must be listening before the top frame starts the
		// handshake, or they miss the init request and we are back to paying the
		// 5s timeout this task exists to remove.
		const calls = stubScripting();

		await executeCaptureScript(7);

		expect(calls.map((c) => c.files[0])).toEqual([
			"content/frames.js",
			"content/capture.js",
		]);
	});

	it("captures anyway when a frame cannot be scripted", async () => {
		// A sandboxed or restricted frame is not a reason to abandon the page.
		const calls = stubScripting(async (injection) => {
			if (injection.files[0] === "content/frames.js") {
				throw new Error("Cannot access contents of the frame");
			}
			return [];
		});

		await expect(executeCaptureScript(7)).resolves.toBeUndefined();
		expect(calls.map((c) => c.files[0])).toContain("content/capture.js");
	});

	it("still rejects when the capture script itself cannot be injected", async () => {
		// This one must propagate — the caller reports it to the user.
		stubScripting(async (injection) => {
			if (injection.files[0] === "content/capture.js") {
				throw new Error("Cannot access a chrome:// URL");
			}
			return [];
		});

		await expect(executeCaptureScript(7)).rejects.toThrow(/chrome:\/\//);
	});
});
