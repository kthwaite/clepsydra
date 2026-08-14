import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { CapturePhase, CaptureStatus } from "#/lib/badge";

const client = vi.hoisted(() => ({ isReachable: vi.fn(async () => true) }));

vi.mock("#/lib/api-client", () => ({
	ClepsydraClient: class {
		isReachable = client.isReachable;
	},
}));

type Listener = (event?: {
	preventDefault: () => void;
}) => void | Promise<void>;
interface StatusResponse {
	status: CaptureStatus | null;
}

interface TestTab {
	id: number;
	url: string;
}

type StatusOutcome = StatusResponse | Error | Promise<StatusResponse>;
type StartOutcome = StatusResponse | Error;
type TabOutcome = TestTab[] | Promise<TestTab[]>;

class FakeElement {
	textContent = "";
	disabled = false;
	style = { display: "" };
	dataset: Record<string, string> = {};
	readonly classes = new Set<string>();
	private readonly listeners = new Map<string, Listener>();
	readonly classList = {
		add: (...names: string[]) => {
			for (const name of names) this.classes.add(name);
		},
	};

	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, listener);
	}

	async emit(type: string) {
		await this.listeners.get(type)?.({ preventDefault: () => undefined });
	}
}

interface PopupOptions {
	status?: StatusOutcome[];
	starts?: StartOutcome[];
	tabs?: TabOutcome[];
	storage?: Promise<Record<string, unknown>>;
	namespace?: "browser" | "chrome";
}

interface PopupHarness {
	elements: Record<string, FakeElement>;
	messages: unknown[];
	sendMessage: Mock;
	scripting: Mock;
	close: Mock;
	unload: () => void;
}

function captureStatus(
	phase: CapturePhase,
	detail: string,
	attemptId = `attempt-${phase}`,
): CaptureStatus {
	return {
		phase,
		detail,
		attemptId,
		startedAt: 10,
		updatedAt: 20,
		additionalTags: [],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function messageHasType(message: unknown, type: string): boolean {
	if (!message || typeof message !== "object" || !("type" in message)) {
		return false;
	}
	return message.type === type;
}

async function settle() {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

async function openPopup(options: PopupOptions = {}): Promise<PopupHarness> {
	const ids = [
		"status-dot",
		"status-text",
		"error-msg",
		"capture-btn",
		"capture-status",
		"options-link",
	];
	const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
	const messages: unknown[] = [];
	const statusOutcomes = options.status ?? [{ status: null }];
	const startOutcomes = options.starts ?? [
		{ status: captureStatus("capturing", "reading the page…") },
	];
	const tabOutcomes = options.tabs ?? [
		[{ id: 7, url: "https://example.com/article" }],
	];
	let statusQuery = 0;
	let startRequest = 0;
	let tabQuery = 0;
	let unload: () => void = () => undefined;
	const close = vi.fn();
	const scripting = vi.fn(async () => []);
	const sendMessage = vi.fn(async (message: { type?: string }) => {
		messages.push(message);
		const outcomes =
			message.type === "capture_start" ? startOutcomes : statusOutcomes;
		const index =
			message.type === "capture_start" ? startRequest++ : statusQuery++;
		const outcome = outcomes[Math.min(index, outcomes.length - 1)];
		if (outcome instanceof Error) throw outcome;
		return outcome;
	});
	vi.stubGlobal("document", {
		getElementById: (id: string) => elements[id],
	});
	vi.stubGlobal("window", {
		close,
		addEventListener: (type: string, listener: () => void) => {
			if (type === "unload") unload = listener;
		},
	});
	const api = {
		storage: {
			sync: { get: vi.fn(() => options.storage ?? Promise.resolve({})) },
		},
		tabs: {
			query: vi.fn(async () => {
				const outcome =
					tabOutcomes[Math.min(tabQuery, tabOutcomes.length - 1)];
				tabQuery += 1;
				return outcome;
			}),
		},
		runtime: {
			sendMessage,
			openOptionsPage: vi.fn(),
		},
		scripting: { executeScript: scripting },
	};
	const namespace = options.namespace ?? "chrome";
	vi.stubGlobal(namespace, api);
	vi.stubGlobal(namespace === "chrome" ? "browser" : "chrome", undefined);

	// Opening a popup is the module boundary; a static import cannot reload it.
	await import("./popup");
	await settle();
	return { elements, messages, sendMessage, scripting, close, unload };
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
	it("loads and queries the active tab with only the browser namespace", async () => {
		const popup = await openPopup({ namespace: "browser" });

		expect(popup.messages).toContainEqual({ type: "capture_status", tabId: 7 });
	});

	it("binds capture before an unresolved connectivity probe completes", async () => {
		let resolveReachability!: (reachable: boolean) => void;
		client.isReachable.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				resolveReachability = resolve;
			}),
		);
		const popup = await openPopup();

		await popup.elements["capture-btn"].emit("click");

		expect(popup.messages).toContainEqual({ type: "capture_start", tabId: 7 });
		expect(popup.close).not.toHaveBeenCalled();
		resolveReachability(true);
		await settle();
	});

	it("binds capture before unresolved settings initialization", async () => {
		const storage = new Promise<Record<string, unknown>>(() => undefined);
		const popup = await openPopup({ storage });

		await popup.elements["capture-btn"].emit("click");

		expect(popup.messages).toContainEqual({ type: "capture_start", tabId: 7 });
	});

	it("disables immediately and suppresses duplicate clicks while tab lookup waits", async () => {
		const tabLookup = deferred<TestTab[]>();
		const popup = await openPopup({
			tabs: [
				[{ id: 7, url: "https://example.com/article" }],
				tabLookup.promise,
			],
		});

		const firstClick = popup.elements["capture-btn"].emit("click");
		await settle();
		expect(popup.elements["capture-btn"].disabled).toBe(true);
		expect(popup.elements["capture-status"].textContent).toBe(
			"Starting capture…",
		);

		await popup.elements["capture-btn"].emit("click");
		expect(
			popup.messages.filter((message) =>
				messageHasType(message, "capture_start"),
			),
		).toHaveLength(0);

		tabLookup.resolve([{ id: 7, url: "https://example.com/article" }]);
		await firstClick;
		expect(
			popup.messages.filter((message) =>
				messageHasType(message, "capture_start"),
			),
		).toHaveLength(1);
	});

	it("does not let a retained initialization result overwrite a user start", async () => {
		const retainedStatus = deferred<StatusResponse>();

		const popup = await openPopup({ status: [retainedStatus.promise] });

		await popup.elements["capture-btn"].emit("click");
		expect(popup.elements["capture-status"].textContent).toBe(
			"reading the page…",
		);

		retainedStatus.resolve({
			status: captureStatus("done", "An older capture completed.", "older"),
		});
		await settle();

		expect(popup.elements["capture-status"].textContent).toBe(
			"reading the page…",
		);
		expect(popup.elements["capture-btn"].disabled).toBe(true);
	});
	it.each([
		{ name: "missing tab", target: [] },
		{
			name: "restricted tab",
			target: [{ id: 7, url: "chrome://settings" }],
		},
	] as const)("uses one feedback surface for a $name", async ({ target }) => {
		const popup = await openPopup({
			tabs: [[{ id: 7, url: "https://example.com/article" }], [...target]],
		});

		await popup.elements["capture-btn"].emit("click");

		expect(popup.elements["capture-status"].style.display).toBe("block");
		expect(popup.elements["error-msg"].style.display).not.toBe("block");
	});

	it("starts capture through the worker and keeps the popup open", async () => {
		const popup = await openPopup();

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
			const popup = await openPopup({
				status: [{ status: captureStatus(phase, detail) }],
			});

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
			const popup = await openPopup({
				status: [{ status: captureStatus(phase, detail) }],
			});

			expect(popup.elements["capture-status"].textContent).toBe(detail);
			expect(popup.elements["capture-status"].dataset.tone).toBe(tone);
			expect(popup.elements["capture-btn"].disabled).toBe(false);
		},
	);

	it("keeps explicit null status distinct from a transport failure", async () => {
		const popup = await openPopup({ status: [{ status: null }] });

		expect(popup.elements["error-msg"].style.display).not.toBe("block");
		expect(popup.elements["capture-status"].style.display).not.toBe("block");
		expect(popup.elements["capture-btn"].disabled).toBe(false);
	});

	it("handles explicit null during polling without calling it a transport failure", async () => {
		vi.useFakeTimers();
		const popup = await openPopup({
			status: [
				{ status: captureStatus("capturing", "reading the page…") },
				{ status: null },
			],
		});

		await vi.advanceTimersByTimeAsync(250);

		expect(popup.elements["error-msg"].style.display).not.toBe("block");
		expect(popup.elements["capture-status"].textContent).toContain(
			"No capture is currently running",
		);
		expect(popup.elements["capture-btn"].disabled).toBe(false);
	});

	it("surfaces polling transport failure as recoverable and re-enables capture", async () => {
		vi.useFakeTimers();
		const popup = await openPopup({
			status: [
				{ status: captureStatus("capturing", "reading the page…") },
				new Error("message port closed"),
			],
		});
		expect(popup.elements["capture-btn"].disabled).toBe(true);

		await vi.advanceTimersByTimeAsync(250);

		expect(popup.elements["error-msg"].style.display).toBe("block");
		expect(popup.elements["error-msg"].textContent).toContain(
			"Capture status is temporarily unavailable",
		);
		expect(popup.elements["capture-btn"].disabled).toBe(false);
	});

	it("allows a failed capture start to be retried successfully", async () => {
		const popup = await openPopup({
			starts: [
				new Error("worker unavailable"),
				{ status: captureStatus("capturing", "reading the page…", "retry") },
			],
		});

		await popup.elements["capture-btn"].emit("click");
		expect(popup.elements["capture-btn"].disabled).toBe(false);
		expect(popup.elements["capture-status"].textContent).toContain(
			"Capture could not start: worker unavailable.",
		);
		expect(popup.elements["capture-status"].textContent).toContain(
			"Try again.",
		);

		await popup.elements["capture-btn"].emit("click");

		expect(
			popup.messages.filter((message) =>
				messageHasType(message, "capture_start"),
			),
		).toHaveLength(2);
		expect(popup.elements["capture-btn"].disabled).toBe(true);
		expect(popup.elements["capture-status"].textContent).toBe(
			"reading the page…",
		);
	});

	it("connectivity failure updates connectivity UI without blocking capture", async () => {
		client.isReachable.mockResolvedValueOnce(false);
		const popup = await openPopup();

		expect(popup.elements["status-dot"].classes).toContain("disconnected");
		expect(popup.elements["status-text"].textContent).toBe(
			"Server unreachable",
		);
		expect(popup.elements["capture-btn"].disabled).toBe(false);
		expect(popup.elements["error-msg"].style.display).not.toBe("block");
	});

	it("polls no faster than 250ms and stops after a terminal result", async () => {
		vi.useFakeTimers();
		const popup = await openPopup({
			status: [
				{ status: captureStatus("capturing", "reading the page…") },
				{
					status: captureStatus(
						"done",
						"A useful page was archived to archives/example/article.md.",
					),
				},
			],
		});
		expect(popup.messages).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(249);
		expect(popup.messages).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(popup.messages).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(popup.messages).toHaveLength(2);
		expect(popup.elements["capture-status"].dataset.tone).toBe("success");
	});

	it("cancels polling when the popup unloads", async () => {
		vi.useFakeTimers();
		const popup = await openPopup({
			status: [{ status: captureStatus("capturing", "reading the page…") }],
		});

		expect(popup.elements["capture-btn"].disabled).toBe(true);
		popup.unload();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(popup.messages).toHaveLength(1);
	});

	it("ships native accessible controls and live feedback in the real popup markup", () => {
		const markup = readFileSync(
			new URL("./popup.html", import.meta.url),
			"utf8",
		);

		expect(markup).toMatch(/<html\s+lang="en">/);
		expect(markup).toMatch(/<button\s+id="capture-btn"[^>]*>/);
		expect(markup).toMatch(/<a\s+[^>]*id="options-link"[^>]*>Settings<\/a>/);
		expect(markup).toMatch(
			/id="capture-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
		);
		expect(markup).toMatch(
			/id="status-text"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
		);
		expect(markup).toMatch(/id="error-msg"[^>]*role="alert"/);
		expect(markup).toContain("Checking…");
		expect(markup).toMatch(/overflow-wrap:\s*anywhere/);
		expect(markup).toMatch(/\.settings-link[^}]*min-height:\s*24px/s);
		expect(markup).toMatch(/\.dot[^}]*flex:\s*none/s);
		expect(markup).toMatch(
			/#status-text[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
		);
	});
});
