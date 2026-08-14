import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { CaptureStatus } from "#/lib/badge";

const client = vi.hoisted(() => ({ isReachable: vi.fn(async () => true) }));

vi.mock("#/lib/api-client", () => ({
	ClepsydraClient: class {
		isReachable = client.isReachable;
	},
}));

type Listener = (event?: { preventDefault: () => void }) => void | Promise<void>;

class FakeElement {
	textContent = "";
	disabled = false;
	style = { display: "" };
	dataset: Record<string, string> = {};
	readonly classes = new Set<string>();
	private readonly listeners = new Map<string, Listener>();
	readonly classList = { add: (...names: string[]) => names.forEach((name) => this.classes.add(name)) };

	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, listener);
	}

	async emit(type: string) {
		await this.listeners.get(type)?.({ preventDefault: () => undefined });
	}
}

interface PopupHarness {
	elements: Record<string, FakeElement>;
	messages: unknown[];
	scripting: Mock;
	close: Mock;
	unload: () => void;
}

async function openPopup(
	responses: Array<{ status: CaptureStatus | null }>,
): Promise<PopupHarness> {
	const ids = [
		"status-dot",
		"status-text",
		"error-msg",
		"capture-btn",
		"progress",
		"capture-status",
		"options-link",
	];
	const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
	const messages: unknown[] = [];
	let statusQuery = 0;
	let unload = () => undefined;
	const close = vi.fn();
	const scripting = vi.fn(async () => []);
	vi.stubGlobal("document", {
		getElementById: (id: string) => elements[id],
	});
	vi.stubGlobal("window", {
		close,
		addEventListener: (type: string, listener: () => void) => {
			if (type === "unload") unload = listener;
		},
	});
	vi.stubGlobal("chrome", {
		storage: { sync: { get: vi.fn(async () => ({})) } },
		tabs: {
			query: vi.fn(
				(_query: unknown, callback: (tabs: Array<{ id: number; url: string }>) => void) =>
					callback([{ id: 7, url: "https://example.com/article" }]),
			),
		},
		runtime: {
			sendMessage: vi.fn(async (message: { type?: string }) => {
				messages.push(message);
				if (message.type === "capture_start") {
					return {
						status: { phase: "capturing", detail: "reading the page…" },
					};
				}
				const response = responses[Math.min(statusQuery, responses.length - 1)];
				statusQuery += 1;
				return response;
			}),
			openOptionsPage: vi.fn(),
		},
		scripting: { executeScript: scripting },
	});

	// Popup initialization is intentionally a module side effect. Reloading it is
	// the observable boundary for opening a fresh popup window.
	await import("./popup");
	for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
	return { elements, messages, scripting, close, unload };
}

beforeEach(() => {
	vi.resetModules();
	vi.useRealTimers();
	client.isReachable.mockClear().mockResolvedValue(true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("popup capture feedback", () => {
	it("starts capture through the worker and keeps the popup open", async () => {
		const popup = await openPopup([{ status: null }]);

		await popup.elements["capture-btn"].emit("click");

		expect(popup.messages).toContainEqual({ type: "capture_start", tabId: 7 });
		expect(popup.scripting).not.toHaveBeenCalled();
		expect(popup.close).not.toHaveBeenCalled();
		expect(popup.elements["capture-btn"].disabled).toBe(true);
		expect(popup.elements["capture-status"].textContent).toBe(
			"reading the page…",
		);
	});

	it.each([
		["capturing", "reading the page…", "reading"],
		["processing", "building the snapshot…", "processing"],
		["uploading", "sending to the vault…", "processing"],
	] as const)(
		"renders active %s progress and disables capture",
		async (phase, detail, tone) => {
			const popup = await openPopup([{ status: { phase, detail } }]);

			expect(popup.elements["capture-status"].textContent).toBe(detail);
			expect(popup.elements["capture-status"].dataset.tone).toBe(tone);
			expect(popup.elements["capture-btn"].disabled).toBe(true);
		},
	);

	it.each([
		[
			"done",
			"A useful page was archived to archives/example/article.md.",
			"success",
		],
		["duplicate", "A useful page was already archived.", "success"],
		[
			"conflict",
			"A useful page changed since it was archived. The existing page was left untouched.",
			"conflict",
		],
		["error", "Capture could not start: access denied", "error"],
	] as const)(
		"renders retained %s detail and leaves capture available",
		async (phase, detail, tone) => {
			const popup = await openPopup([{ status: { phase, detail } }]);

			expect(popup.elements["capture-status"].textContent).toBe(detail);
			expect(popup.elements["capture-status"].dataset.tone).toBe(tone);
			expect(popup.elements["capture-btn"].disabled).toBe(false);
		},
	);

	it("polls no faster than 250ms and stops after a terminal result", async () => {
		vi.useFakeTimers();
		const popup = await openPopup([
			{ status: { phase: "capturing", detail: "reading the page…" } },
			{
				status: {
					phase: "done",
					detail: "A useful page was archived to archives/example/article.md.",
				},
			},
		]);
		expect(popup.messages).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(249);
		expect(popup.messages).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(popup.messages).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(popup.messages).toHaveLength(2);
		expect(popup.elements["capture-status"].dataset.tone).toBe("success");
	});

	it("stops polling when the popup unloads", async () => {
		vi.useFakeTimers();
		const popup = await openPopup([
			{ status: { phase: "capturing", detail: "reading the page…" } },
		]);

		expect(popup.elements["capture-btn"].disabled).toBe(true);
		expect(popup.elements["capture-status"].textContent).toBe(
			"reading the page…",
		);
		popup.unload();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(popup.messages).toHaveLength(1);
	});
});
