import { afterEach, describe, expect, it, vi } from "vitest";

import { SingleFileRuntime } from "#/lib/singlefile-runtime";

const FRAME_RESPONSE = "singlefile.frameTree.initResponse";
const FRAME_ACK = "singlefile.frameTree.ackInitRequest";
const LAZY_SET = "singlefile.lazyTimeout.setTimeout";
const LAZY_CLEAR = "singlefile.lazyTimeout.clearTimeout";

function sender(tabId = 17, frameId = 3): chrome.runtime.MessageSender {
	return { tab: { id: tabId }, frameId } as chrome.runtime.MessageSender;
}

describe("SingleFileRuntime", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([FRAME_RESPONSE, FRAME_ACK])(
		"routes %s back to the top frame so the capture session can resolve",
		async (method) => {
			const sendToTab = vi.fn().mockResolvedValue({});
			const runtime = new SingleFileRuntime(sendToTab);
			const message = {
				method,
				frames: [],
				sessionId: "session-1",
			};

			const response = runtime.handleMessage(message, sender());
			await expect(response).resolves.toEqual({});
			expect(sendToTab).toHaveBeenCalledWith(17, message, { frameId: 0 });
		},
	);

	it("runs and clears SingleFile lazy timers through worker messages", async () => {
		vi.useFakeTimers();
		const sendToTab = vi.fn().mockResolvedValue({});
		const runtime = new SingleFileRuntime(sendToTab);

		await expect(
			runtime.handleMessage(
				{ method: LAZY_SET, type: "load-deferred-images", delay: 25 },
				sender(),
			),
		).resolves.toEqual({});
		await vi.advanceTimersByTimeAsync(25);
		expect(sendToTab).toHaveBeenCalledWith(17, {
			method: "singlefile.lazyTimeout.onTimeout",
			type: "load-deferred-images",
		});

		await expect(
			runtime.handleMessage(
				{ method: LAZY_SET, type: "cancelled", delay: 25 },
				sender(),
			),
		).resolves.toEqual({});
		await expect(
			runtime.handleMessage(
				{ method: LAZY_CLEAR, type: "cancelled" },
				sender(),
			),
		).resolves.toEqual({});
		await vi.advanceTimersByTimeAsync(25);
		expect(sendToTab).toHaveBeenCalledTimes(1);
	});

	it("replaces a same-tab same-frame lazy timer and removes tab timers", async () => {
		vi.useFakeTimers();
		const sendToTab = vi.fn().mockResolvedValue({});
		const runtime = new SingleFileRuntime(sendToTab);

		runtime.handleMessage(
			{ method: LAZY_SET, type: "deferred", delay: 10 },
			sender(),
		);
		runtime.handleMessage(
			{ method: LAZY_SET, type: "deferred", delay: 20 },
			sender(),
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(sendToTab).not.toHaveBeenCalled();
		runtime.removeTab(17);
		await vi.advanceTimersByTimeAsync(20);
		expect(sendToTab).not.toHaveBeenCalled();
	});

	it.each([
		["unknown message", { method: "not-singlefile" }, sender()],
		["missing tab", { method: FRAME_RESPONSE, frames: [], sessionId: "x" }, {}],
		[
			"invalid lazy delay",
			{ method: LAZY_SET, type: "x", delay: -1 },
			sender(),
		],
		["invalid lazy type", { method: LAZY_CLEAR, type: "" }, sender()],
	])("ignores %s rather than claiming the message", (_case, message, from) => {
		const runtime = new SingleFileRuntime(vi.fn());

		expect(
			runtime.handleMessage(message, from as chrome.runtime.MessageSender),
		).toBeUndefined();
	});
});
