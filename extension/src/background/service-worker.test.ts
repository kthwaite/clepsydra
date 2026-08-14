import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
	executeCaptureScript: vi.fn(),
	ingestArchive: vi.fn(),
}));

vi.mock("#/lib/inject-capture", () => ({
	executeCaptureScript: dependencies.executeCaptureScript,
}));

vi.mock("#/lib/api-client", () => {
	class ArchiveConflictError extends Error {
		constructor(public detail: unknown) {
			super("URL already archived with different content");
		}
	}
	class ClepsydraClient {
		ingestArchive = dependencies.ingestArchive;
	}
	return { ArchiveConflictError, ClepsydraClient };
});

type WorkerListener = (
	message: unknown,
	sender: { tab?: { id?: number }; frameId?: number },
	sendResponse: (response?: unknown) => void,
) => unknown;

interface WorkerEndpoint {
	dispatch: (
		message: unknown,
		sender?: { tab?: { id?: number }; frameId?: number },
	) => Promise<unknown>;
}

const metadata = {
	url: "https://example.com/article",
	title: "A useful page",
	article_html: "<p>Useful article text</p>",
	article_text_length: 250,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function loadWorker() {
	let listener: WorkerListener | undefined;
	const notifications: Array<{ title: string; message: string }> = [];
	// The listener is module state, so each test intentionally reloads this
	// fixed module after installing a fresh chrome test double.
	const badgeText = vi.fn();
	const title = vi.fn();
	vi.stubGlobal("chrome", {
		runtime: {
			onMessage: {
				addListener: (next: WorkerListener) => {
					listener = next;
				},
			},
			onConnect: { addListener: vi.fn() },
			getPlatformInfo: vi.fn(async () => ({})),
			getURL: (path: string) => `chrome-extension://test/${path}`,
		},
		storage: {
			sync: {
				get: vi.fn(async () => ({
					settings: {
						server_url: "http://localhost:3500",
						default_tags: [],
						notify_on_success: true,
						notify_on_duplicate: true,
					},
				})),
			},
		},
		notifications: {
			create: vi.fn(async (notification: { title: string; message: string }) => {
				notifications.push(notification);
			}),
		},
		tabs: {
			get: vi.fn(async (tabId: number) => ({
				id: tabId,
				url: "https://example.com/article",
			})),
			query: vi.fn(),
			sendMessage: vi.fn(async () => ({})),
			onRemoved: { addListener: vi.fn() },
		},
		action: {
			setBadgeText: badgeText,
			setBadgeBackgroundColor: vi.fn(),
			setTitle: title,
			onClicked: { addListener: vi.fn() },
		},
		commands: { onCommand: { addListener: vi.fn() } },
	});

	await import("./service-worker");
	if (!listener) throw new Error("service worker did not register a listener");

	const dispatch = async (
		message: unknown,
		sender: { tab?: { id?: number }; frameId?: number } = {},
	) => {
		let response: unknown;
		const returned = listener?.(message, sender, (value) => {
			response = value;
		});
		if (returned instanceof Promise) {
			const resolved = await returned;
			if (resolved !== undefined) response = resolved;
		}
		return response;
	};
	const query = (tabId = 7) => dispatch({ type: "capture_status", tabId });
	return { dispatch, query, notifications, badgeText, title };
}

async function completeTransfer(
	dispatch: WorkerEndpoint["dispatch"],
	captureId = "capture-1",
) {
	await dispatch(
		{ type: "capture_meta", captureId, metadata },
		{ tab: { id: 7 } },
	);
	await dispatch(
		{
			type: "capture_chunk",
			captureId,
			index: 0,
			total: 1,
			text: "<!doctype html><title>A useful page</title>",
		},
		{ tab: { id: 7 } },
	);
}

beforeEach(() => {
	vi.resetModules();
	vi.useRealTimers();
	dependencies.executeCaptureScript.mockReset().mockResolvedValue(undefined);
	dependencies.ingestArchive.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("service-worker capture feedback", () => {
	it("owns popup capture start and exposes capturing before injection finishes", async () => {
		const injection = deferred<void>();
		dependencies.executeCaptureScript.mockReturnValueOnce(injection.promise);
		const worker = await loadWorker();

		const response = await worker.dispatch({ type: "capture_start", tabId: 7 });

		expect(dependencies.executeCaptureScript).toHaveBeenCalledWith(7);
		expect(response).toEqual({
			status: { phase: "capturing", detail: "reading the page…" },
		});
		expect(await worker.query()).toEqual(response);
		injection.resolve();
		await injection.promise;
	});

	it.each([
		{
			name: "success",
			result: {
				status: "created",
				vault_path: "archives/example/article.md",
				page_id: "page-1",
				blobs_stored: 1,
				blobs_deduped: 0,
			},
			status: {
				phase: "done",
				detail: "A useful page was archived to archives/example/article.md.",
			},
		},
		{
			name: "duplicate",
			result: {
				status: "already_exists",
				vault_path: "archives/example/article.md",
				page_id: "page-1",
				blobs_stored: 0,
				blobs_deduped: 1,
			},
			status: {
				phase: "duplicate",
				detail: "A useful page was already archived.",
			},
		},
	])("publishes structured $name detail", async ({ result, status }) => {
		dependencies.ingestArchive.mockResolvedValueOnce(result);
		const worker = await loadWorker();

		await completeTransfer(worker.dispatch);

		await vi.waitFor(async () => {
			expect(await worker.query()).toEqual({ status });
		});
	});

	it("publishes the server conflict detail", async () => {
		const { ArchiveConflictError } = await import("#/lib/api-client");
		dependencies.ingestArchive.mockRejectedValueOnce(
			new ArchiveConflictError({ vault_path: "archives/example/existing.md" }),
		);
		const worker = await loadWorker();

		await completeTransfer(worker.dispatch);

		await vi.waitFor(async () => {
			expect(await worker.query()).toEqual({
				status: {
					phase: "conflict",
					detail:
						"A useful page changed since it was archived at archives/example/existing.md. The existing page was left untouched.",
				},
			});
		});
	});

	it.each([
		{
			name: "injection failure",
			trigger: async (worker: WorkerEndpoint) => {
				dependencies.executeCaptureScript.mockRejectedValueOnce(
					new Error("Cannot access a chrome:// URL"),
				);
				await worker.dispatch({ type: "capture_start", tabId: 7 });
			},
			detail: "Capture could not start: Cannot access a chrome:// URL",
		},
		{
			name: "malformed transfer",
			trigger: async (worker: WorkerEndpoint) => {
				await worker.dispatch(
					{
						type: "capture_chunk",
						captureId: "bad",
						index: 1,
						total: 1,
						text: "bad",
					},
					{ tab: { id: 7 } },
				);
			},
			detail:
				'Malformed snapshot transfer: Error: Invalid capture chunk "bad": index 1 must be a safe integer between 0 and 0',
		},
		{
			name: "lost metadata",
			trigger: async (worker: WorkerEndpoint) => {
				await worker.dispatch(
					{
						type: "capture_chunk",
						captureId: "missing-metadata",
						index: 0,
						total: 1,
						text: "snapshot",
					},
					{ tab: { id: 7 } },
				);
			},
			detail: "Capture metadata was lost in transit.",
		},
		{
			name: "content error",
			trigger: async (worker: WorkerEndpoint) => {
				await worker.dispatch(
					{ type: "capture_error", error: "The page produced an empty snapshot." },
					{ tab: { id: 7 } },
				);
			},
			detail: "The page produced an empty snapshot.",
		},
	])("publishes structured error detail for $name", async ({ trigger, detail }) => {
		const worker = await loadWorker();
		await trigger(worker);

		await vi.waitFor(async () => {
			expect(await worker.query()).toEqual({
				status: { phase: "error", detail },
			});
		});
	});

	it("publishes transfer expiry detail", async () => {
		vi.useFakeTimers();
		const worker = await loadWorker();
		await worker.dispatch(
			{ type: "capture_meta", captureId: "slow", metadata },
			{ tab: { id: 7 } },
		);

		await vi.advanceTimersByTimeAsync(30_000);

		expect(await worker.query()).toEqual({
			status: {
				phase: "error",
				detail: "Snapshot transfer slow expired after 30 seconds of inactivity.",
			},
		});
	});

	it("clears a success badge without erasing the retained terminal result", async () => {
		vi.useFakeTimers();
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "created",
			vault_path: "archives/example/article.md",
			page_id: "page-1",
			blobs_stored: 1,
			blobs_deduped: 0,
		});
		const worker = await loadWorker();
		await completeTransfer(worker.dispatch);
		await vi.waitFor(async () => {
			expect(await worker.query()).toEqual({
				status: {
					phase: "done",
					detail: "A useful page was archived to archives/example/article.md.",
				},
			});
		});

		await vi.advanceTimersByTimeAsync(5_000);

		expect(worker.badgeText).toHaveBeenLastCalledWith({ text: "", tabId: 7 });
		expect(await worker.query()).toEqual({
			status: {
				phase: "done",
				detail: "A useful page was archived to archives/example/article.md.",
			},
		});
	});
});
