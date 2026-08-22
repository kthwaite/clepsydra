import { type Mock, afterEach, describe, expect, it, vi } from "vitest";

const runtime = { id: "clepsydra-test" };
interface TestOptionsElement {
	value: string;
	checked: boolean;
	style: { display: string };
	dataset: Record<string, string>;
	textContent: string;
	addEventListener: Mock;
}

async function loadWith(root: { browser?: unknown; chrome?: unknown }) {
	vi.resetModules();
	vi.stubGlobal("browser", root.browser);
	vi.stubGlobal("chrome", root.chrome);
	return import("#/lib/webext");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock("@mozilla/readability");
	vi.doUnmock("#/lib/api-client");
	vi.doUnmock("#/lib/capture-hygiene");
	vi.doUnmock("#/lib/chunked-transfer");
	vi.doUnmock("#/lib/relay-fetch");
	vi.doUnmock("#/lib/singlefile");
});

describe("webext", () => {
	it("prefers a native browser namespace", async () => {
		const browser = { runtime };
		const chrome = { runtime: { id: "chrome-test" } };
		expect((await loadWith({ browser, chrome })).webext).toBe(browser);
	});

	it("falls back to chrome", async () => {
		const chrome = { runtime };
		expect((await loadWith({ chrome })).webext).toBe(chrome);
	});

	it("fails clearly without either runtime", async () => {
		await expect(loadWith({})).rejects.toThrow(
			"WebExtension API unavailable: neither browser.runtime nor chrome.runtime exists.",
		);
	});
});

describe("browser-only entry modules", () => {
	it("runs content capture with chrome absent", async () => {
		vi.resetModules();
		const sendMessage = vi.fn(async () => undefined);
		vi.stubGlobal("browser", {
			runtime: { sendMessage },
			storage: { sync: { get: vi.fn(async () => ({})) } },
		});
		vi.stubGlobal("chrome", undefined);
		vi.stubGlobal("document", {
			cloneNode: () => ({}),
			querySelector: () => null,
			title: "Captured page",
			documentElement: { lang: "en" },
		});
		vi.stubGlobal("window", {
			location: { href: "https://example.com/article" },
		});
		vi.doMock("@mozilla/readability", () => ({
			Readability: class {
				parse() {
					return {
						content: "<p>Captured article</p>",
						textContent: "Captured article",
					};
				}
			},
		}));
		vi.doMock("#/lib/capture-hygiene", () => ({
			snapshotRejection: () => undefined,
		}));
		vi.doMock("#/lib/chunked-transfer", () => ({
			sendCaptureTransfer: async (
				_captureId: string,
				message: unknown,
				_snapshotHtml: string,
				send: (value: unknown) => Promise<unknown>,
			) => send(message),
		}));
		vi.doMock("#/lib/relay-fetch", () => ({
			createRelayFetch: () => vi.fn(),
		}));
		vi.doMock("#/lib/singlefile", () => ({
			captureSnapshot: async () => "<html>captured snapshot</html>",
		}));

		// Content capture executes at module load, after its namespace is installed.
		await import("#/content/capture");

		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
	});

	it("initializes options with chrome absent", async () => {
		vi.resetModules();
		const storageGet = vi.fn(async () => ({}));
		vi.stubGlobal("browser", {
			runtime: {},
			storage: { sync: { get: storageGet, set: vi.fn(async () => undefined) } },
		});
		vi.stubGlobal("chrome", undefined);
		const makeElement = (): TestOptionsElement => ({
			value: "",
			checked: false,
			style: { display: "" },
			dataset: {},
			textContent: "",
			addEventListener: vi.fn(),
		});
		const elements: Record<string, TestOptionsElement> = {
			"server-url": makeElement(),
			"default-tags": makeElement(),
			"notify-success": makeElement(),
			"notify-duplicate": makeElement(),
			"max-blob-mb": makeElement(),
			"save-btn": makeElement(),
			"saved-msg": makeElement(),
			"status-box": makeElement(),
		};
		vi.stubGlobal("document", {
			getElementById: (id: string) => elements[id],
		});
		vi.doMock("#/lib/api-client", () => ({
			ClepsydraClient: class {
				async getStatus() {
					return { blob_count: 0, total_size_bytes: 0 };
				}
			},
		}));

		// Options initialization executes at module load after the browser stub.
		await import("#/options/options");

		await vi.waitFor(() => expect(storageGet).toHaveBeenCalledWith("settings"));
		// Wait for the reachability check too. Without this the test finishes
		// while checkStatus is still in flight, teardown unmocks the client, and
		// the real one's failed fetch lands on a torn-down DOM stub as an
		// unhandled rejection.
		await vi.waitFor(() =>
			expect(elements["status-box"].dataset.tone).toBe("ok"),
		);
	});
});
