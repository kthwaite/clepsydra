import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { CapturePhase, CaptureStatus } from "#/lib/badge";
import type { ArchiveLookupResponse } from "#/lib/types";
const linkedom = createRequire(import.meta.url)("linkedom") as {
	parseHTML: (markup: string) => { document: Document; window: Window };
	Event: typeof globalThis.Event;
};
const parseHTML = linkedom.parseHTML;

function keyEvent(key: string): Event {
	const event = new linkedom.Event("keydown", { cancelable: true }) as Event & {
		key: string;
	};
	event.key = key;
	return event;
}

const client = vi.hoisted(() => ({
	isReachable: vi.fn(async () => true),
	lookupArchive: vi.fn(
		async (): Promise<ArchiveLookupResponse> => ({ status: "none" }),
	),
}));

vi.mock("#/lib/api-client", () => ({
	ClepsydraClient: class {
		isReachable = client.isReachable;
		lookupArchive = client.lookupArchive;
		suggestTags = vi.fn().mockResolvedValue([]);
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
	private ownTextContent = "";
	textContent = "";
	disabled = false;
	value = "";
	className = "";
	href = "";
	hidden = false;
	style: Record<string, string> = { display: "" };
	dataset: Record<string, string> = {};
	readonly children: FakeElement[] = [];
	readonly classes = new Set<string>();
	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Listener>();
	readonly classList = {
		add: (...names: string[]) => {
			for (const name of names) this.classes.add(name);
		},
		remove: (...names: string[]) => {
			for (const name of names) this.classes.delete(name);
		},
	};

	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, listener);
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	replaceChildren() {
		this.children.length = 0;
		this.textContent = "";
		this.ownTextContent = "";
	}

	append(child: FakeElement) {
		this.children.push(child);
		this.textContent = `${this.ownTextContent}${this.children
			.map((item) => item.textContent)
			.join("")}`;
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
	storageSet: Mock;
	scripting: Mock;
	close: Mock;
	unload: () => void;
}

function captureStatus(
	phase: CapturePhase,
	detail: string,
	attemptId = `attempt-${phase}`,
	additionalTags: string[] = [],
): CaptureStatus {
	return {
		phase,
		detail,
		attemptId,
		startedAt: 10,
		updatedAt: 20,
		additionalTags,
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

async function openRealPopup(
	settings: Record<string, unknown>,
	options: { tabUrl?: string | null } = {},
) {
	const markup = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
	const parsed = parseHTML(markup);
	const storageSet = vi.fn();
	const tabUrl = options.tabUrl ?? null;
	const tabs = tabUrl === null ? [] : [{ id: 7, url: tabUrl }];
	const api = {
		storage: {
			sync: {
				get: vi.fn(async () => ({ settings })),
				set: storageSet,
			},
		},
		tabs: { query: vi.fn(async () => tabs) },
		runtime: {
			sendMessage: vi.fn(async () => ({ status: null })),
			openOptionsPage: vi.fn(),
		},
		scripting: { executeScript: vi.fn() },
	};
	vi.stubGlobal("document", parsed.document);
	vi.stubGlobal("window", parsed.window);
	vi.stubGlobal("chrome", api);
	vi.stubGlobal("browser", undefined);

	await import("./popup");
	await settle();
	return {
		document: parsed.document,
		storageSet,
		sendMessage: api.runtime.sendMessage,
	};
}

function messageHasType(message: unknown, type: string): boolean {
	if (!message || typeof message !== "object" || !("type" in message)) {
		return false;
	}
	return message.type === type;
}

/**
 * Each rendered chip is `span.tag > (span label, button.tag-remove)`; read
 * the label leaf directly rather than the chip's own `textContent`, which
 * FakeElement.append recomputes from children and would otherwise fold in
 * the remove button's glyph too.
 */
function chipLabels(popup: PopupHarness): (string | undefined)[] {
	return popup.elements["selected-tags"].children.map(
		(chip) => chip.children[0]?.textContent,
	);
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
		"capture-progress",
		"capture-progress-fill",
		"capture-link",
		"options-link",
		"default-tags",
		"additional-tags",
		"selected-tags",
		"tag-suggestions",
		"captured-indicator",
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
	const storageSet = vi.fn();
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
		createElement: () => new FakeElement(),
	});
	vi.stubGlobal("window", {
		close,
		addEventListener: (type: string, listener: () => void) => {
			if (type === "unload") unload = listener;
		},
	});
	const api = {
		storage: {
			sync: {
				get: vi.fn(() => options.storage ?? Promise.resolve({})),
				set: storageSet,
			},
		},
		tabs: {
			query: vi.fn(async () => {
				const outcome = tabOutcomes[Math.min(tabQuery, tabOutcomes.length - 1)];
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
	return {
		elements,
		messages,
		sendMessage,
		storageSet,
		scripting,
		close,
		unload,
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.useRealTimers();
	client.isReachable.mockClear().mockResolvedValue(true);
	client.lookupArchive.mockClear().mockResolvedValue({ status: "none" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("popup tag controls", () => {
	it("ships labelled native controls in the real popup markup", () => {
		const markup = readFileSync(
			new URL("./popup.html", import.meta.url),
			"utf8",
		);
		const { document } = parseHTML(markup);
		const defaultsLabel = document.querySelector("#capture-tags-label");
		const input = document.querySelector<HTMLInputElement>("#additional-tags");
		const inputLabel = document.querySelector('label[for="additional-tags"]');

		expect(defaultsLabel?.textContent).toBe("Defaults");
		expect(input?.tagName).toBe("INPUT");
		expect(input?.getAttribute("type")).toBe("text");
		expect(input?.hasAttribute("disabled")).toBe(false);
		expect(inputLabel?.textContent).toBe("Additional tags");
		expect(document.body.textContent).toMatch(/only to this capture/i);
	});

	it("ships the tag picker's combobox and listbox markup in the real popup", () => {
		const markup = readFileSync(
			new URL("./popup.html", import.meta.url),
			"utf8",
		);
		const { document } = parseHTML(markup);
		const input = document.querySelector<HTMLInputElement>("#additional-tags");
		const listbox = document.querySelector("#tag-suggestions");

		expect(input?.getAttribute("role")).toBe("combobox");
		expect(input?.getAttribute("aria-expanded")).toBe("false");
		expect(input?.getAttribute("aria-controls")).toBe("tag-suggestions");
		expect(listbox?.getAttribute("role")).toBe("listbox");
		expect(listbox?.hasAttribute("hidden")).toBe(true);
		expect(document.querySelector("#selected-tags")).not.toBeNull();
	});

	it("sends chips committed via Enter plus trailing uncommitted text on capture", async () => {
		const popup = await openRealPopup(
			{},
			{ tabUrl: "https://example.com/article" },
		);
		const input =
			popup.document.querySelector<HTMLInputElement>("#additional-tags");
		const button =
			popup.document.querySelector<HTMLButtonElement>("#capture-btn");
		if (!input || !button) throw new Error("popup markup missing controls");

		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		input.value = "reading";
		button.dispatchEvent(new linkedom.Event("click"));
		await settle();

		expect(popup.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "capture_start",
				additionalTags: ["research", "reading"],
			}),
		);
	});

	it("renders immutable normalized defaults outside the additions input", async () => {
		const popup = await openRealPopup({
			default_tags: [" #archive ", "research", "archive"],
		});
		const input =
			popup.document.querySelector<HTMLInputElement>("#additional-tags");
		const defaults = Array.from(
			popup.document.querySelectorAll<HTMLElement>("#default-tags .tag"),
			(tag) => tag.textContent,
		);

		expect(defaults).toEqual(["archive", "research"]);
		expect(input?.value).toBe("");
		expect(popup.storageSet).not.toHaveBeenCalled();
		expect(
			popup.document.querySelector(
				'#default-tags button, #default-tags input, #default-tags [role="button"]',
			),
		).toBeNull();
	});

	it("commits uncommitted input text into the capture_start message", async () => {
		const popup = await openPopup();
		popup.elements["additional-tags"].value = "  Reading  ";

		await popup.elements["capture-btn"].emit("click");

		expect(popup.messages).toContainEqual({
			type: "capture_start",
			tabId: 7,
			additionalTags: ["Reading"],
		});
		expect(popup.storageSet).not.toHaveBeenCalled();
	});
	it("shows attempt-owned tags as chips when start acknowledges an existing capture", async () => {
		const popup = await openPopup({
			starts: [
				{
					status: captureStatus(
						"processing",
						"building the snapshot…",
						"existing",
						["attempt-owned"],
					),
				},
			],
		});
		popup.elements["additional-tags"].value = "replacement-draft";

		await popup.elements["capture-btn"].emit("click");

		expect(chipLabels(popup)).toEqual(["attempt-owned"]);
		expect(popup.elements["additional-tags"].disabled).toBe(true);
	});

	it("restores active additions as chips and disables editing", async () => {
		const popup = await openPopup({
			status: [
				{
					status: captureStatus(
						"processing",
						"building the snapshot…",
						"active",
						["research", "reading"],
					),
				},
			],
		});

		expect(chipLabels(popup)).toEqual(["research", "reading"]);
		expect(popup.elements["additional-tags"].disabled).toBe(true);
	});

	it("clears chips for a terminal status", async () => {
		const popup = await openPopup({
			status: [
				{
					status: captureStatus("done", "Archived.", "done", ["research"]),
				},
			],
		});

		expect(chipLabels(popup)).toEqual([]);
		expect(popup.elements["additional-tags"].disabled).toBe(false);
	});

	it("disables additions synchronously while active-tab lookup waits", async () => {
		const tabLookup = deferred<TestTab[]>();
		const popup = await openPopup({
			tabs: [
				[{ id: 7, url: "https://example.com/article" }],
				tabLookup.promise,
			],
		});

		const click = popup.elements["capture-btn"].emit("click");

		expect(popup.elements["additional-tags"].disabled).toBe(true);
		tabLookup.resolve([{ id: 7, url: "https://example.com/article" }]);
		await click;
	});

	it("starts fresh when an active capture reaches a terminal status", async () => {
		vi.useFakeTimers();
		const popup = await openPopup({
			status: [
				{
					status: captureStatus("capturing", "reading the page…", "active", [
						"research",
					]),
				},
				{ status: captureStatus("done", "Archived.", "active", ["research"]) },
			],
		});
		expect(chipLabels(popup)).toEqual(["research"]);

		await vi.advanceTimersByTimeAsync(250);

		expect(chipLabels(popup)).toEqual([]);
		expect(popup.elements["additional-tags"].disabled).toBe(false);
	});

	it("keeps capture interactive and reports unavailable defaults when settings fail", async () => {
		const storage = deferred<Record<string, unknown>>();
		const popup = await openPopup({ storage: storage.promise });
		storage.reject(new Error("settings unavailable"));
		await settle();
		expect(popup.elements["default-tags"].textContent).toBe(
			"Defaults unavailable",
		);
		expect(popup.elements["capture-btn"].disabled).toBe(false);
		await popup.elements["capture-btn"].emit("click");
		expect(popup.messages).toContainEqual({
			type: "capture_start",
			tabId: 7,
			additionalTags: [],
		});
	});

	it("cancels polling on unload without changing the additions draft", async () => {
		vi.useFakeTimers();
		const popup = await openPopup({
			status: [{ status: captureStatus("capturing", "reading the page…") }],
		});
		popup.elements["additional-tags"].value = "unfinished draft";

		popup.unload();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(popup.elements["additional-tags"].value).toBe("unfinished draft");
		expect(popup.messages).toHaveLength(1);
	});
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

		expect(popup.messages).toContainEqual({
			type: "capture_start",
			tabId: 7,
			additionalTags: [],
		});
		expect(popup.close).not.toHaveBeenCalled();
		resolveReachability(true);
		await settle();
	});

	it("binds capture before unresolved settings initialization", async () => {
		const storage = new Promise<Record<string, unknown>>(() => undefined);
		const popup = await openPopup({ storage });

		await popup.elements["capture-btn"].emit("click");

		expect(popup.messages).toContainEqual({
			type: "capture_start",
			tabId: 7,
			additionalTags: [],
		});
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

		expect(popup.messages).toContainEqual({
			type: "capture_start",
			tabId: 7,
			additionalTags: [],
		});
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
		expect(markup).toMatch(
			/id="capture-progress"[^>]*role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"/,
		);
		expect(markup).toMatch(
			/<a[^>]*id="capture-link"[^>]*hidden[^>]*target="_blank"[^>]*rel="noopener"[^>]*>View in Clepsydra<\/a>/,
		);
	});
});

describe("popup progress and outcome link", () => {
	it("renders a determinate progress bar from chunk counts", async () => {
		const popup = await openPopup({
			status: [
				{
					status: {
						...captureStatus("processing", "building the snapshot…"),
						chunksReceived: 3,
						chunksTotal: 4,
					},
				},
			],
		});

		expect(popup.elements["capture-progress"].hidden).toBe(false);
		expect(popup.elements["capture-progress-fill"].classes).not.toContain(
			"indeterminate",
		);
		expect(
			popup.elements["capture-progress"].getAttribute("aria-valuenow"),
		).toBe("64");
	});

	it("renders an indeterminate progress bar while capturing", async () => {
		const popup = await openPopup({
			status: [{ status: captureStatus("capturing", "reading the page…") }],
		});

		expect(popup.elements["capture-progress"].hidden).toBe(false);
		expect(popup.elements["capture-progress-fill"].classes).toContain(
			"indeterminate",
		);
		expect(
			popup.elements["capture-progress"].getAttribute("aria-valuenow"),
		).toBeNull();
	});

	it("hides the progress bar and shows the outcome link for a terminal done status", async () => {
		const popup = await openPopup({
			status: [
				{
					status: {
						...captureStatus(
							"done",
							"A useful page was archived to archive/example.com/a b.md.",
						),
						vaultPath: "archive/example.com/a b.md",
					},
				},
			],
		});

		expect(popup.elements["capture-progress"].hidden).toBe(true);
		expect(popup.elements["capture-link"].hidden).toBe(false);
		expect(popup.elements["capture-link"].href).toBe(
			"http://localhost:3000/pages/archive/example.com/a%20b.md",
		);
	});

	it("leaves the outcome link hidden for a terminal status without a vault path", async () => {
		const popup = await openPopup({
			status: [
				{
					status: captureStatus(
						"error",
						"Capture could not start: access denied",
					),
				},
			],
		});

		expect(popup.elements["capture-progress"].hidden).toBe(true);
		expect(popup.elements["capture-link"].hidden).toBe(true);
	});
});

describe("popup captured indicator", () => {
	it("shows a formatted date and a View link for an active capture", async () => {
		client.lookupArchive.mockResolvedValueOnce({
			status: "active",
			vault_path: "archive/example.com/x.md",
			captured_at: "2026-08-13T12:00:00Z",
		});
		const popup = await openRealPopup(
			{ server_url: "http://localhost:3000" },
			{ tabUrl: "https://example.com/article" },
		);

		const indicator = popup.document.querySelector<HTMLElement>(
			"#captured-indicator",
		);
		const link = popup.document.querySelector<HTMLAnchorElement>(
			"#captured-indicator a",
		);

		expect(indicator?.hidden).toBe(false);
		expect(indicator?.textContent).toContain(
			new Date("2026-08-13T12:00:00Z").toLocaleDateString(),
		);
		expect(link?.textContent).toBe("View");
		expect(link?.getAttribute("href")).toBe(
			"http://localhost:3000/pages/archive/example.com/x.md",
		);
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener");
	});

	it("shows the Rubbish Bin message for a rubbish capture", async () => {
		client.lookupArchive.mockResolvedValueOnce({ status: "rubbish" });
		const popup = await openRealPopup(
			{},
			{ tabUrl: "https://example.com/article" },
		);

		const indicator = popup.document.querySelector<HTMLElement>(
			"#captured-indicator",
		);

		expect(indicator?.hidden).toBe(false);
		expect(indicator?.textContent).toBe(
			"A previous capture of this page is in the Rubbish Bin.",
		);
	});

	it("leaves the indicator hidden when there is no prior capture", async () => {
		client.lookupArchive.mockResolvedValueOnce({ status: "none" });
		const popup = await openRealPopup(
			{},
			{ tabUrl: "https://example.com/article" },
		);

		const indicator = popup.document.querySelector<HTMLElement>(
			"#captured-indicator",
		);

		expect(indicator?.hidden).toBe(true);
	});

	it("leaves the indicator hidden and capture enabled when the lookup rejects", async () => {
		client.lookupArchive.mockRejectedValueOnce(new Error("network error"));
		const popup = await openRealPopup(
			{},
			{ tabUrl: "https://example.com/article" },
		);

		const indicator = popup.document.querySelector<HTMLElement>(
			"#captured-indicator",
		);
		const button =
			popup.document.querySelector<HTMLButtonElement>("#capture-btn");

		expect(indicator?.hidden).toBe(true);
		expect(button?.disabled).toBe(false);
	});

	it("performs no lookup fetch for a non-http tab URL", async () => {
		const popup = await openRealPopup({}, { tabUrl: "ftp://example.com/file" });

		expect(client.lookupArchive).not.toHaveBeenCalled();
		const indicator = popup.document.querySelector<HTMLElement>(
			"#captured-indicator",
		);
		expect(indicator?.hidden).toBe(true);
	});
});
