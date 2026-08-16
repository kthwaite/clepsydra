import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ArchiveConflictError } from "#/lib/api-client";
import type { CaptureStatus } from "#/lib/badge";
import type { ExtensionSettings } from "#/lib/types";

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

type ToolbarTab = Pick<chrome.tabs.Tab, "id" | "url">;

interface WorkerEndpoint {
	dispatch: (
		message: unknown,
		sender?: { tab?: { id?: number }; frameId?: number },
	) => Promise<unknown>;
	query: (tabId?: number) => Promise<unknown>;
	removeTab: (tabId?: number) => void;
	clickToolbar: (tab?: ToolbarTab) => void;
	runCommand: (command?: string) => void;
	clickNotification: (notificationId: string) => void;
	notifications: Array<{ id: string; title: string; message: string }>;
	badgeText: Mock;
	title: Mock;
	tabsCreate: Mock;
}

interface SessionArea {
	data: Record<string, unknown>;
	get: Mock;
	set: Mock;
	remove: Mock;
}

type NotificationBehavior = "absent" | "throws" | "rejects";

interface WorkerOptions {
	session?: SessionArea;
	settings?: Partial<ExtensionSettings>;
	tabsGet?: Mock;
	notifications?: NotificationBehavior;
	namespace?: "browser" | "chrome";
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

function createSessionArea(initial: Record<string, unknown> = {}): SessionArea {
	const data = structuredClone(initial);
	return {
		data,
		get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
		set: vi.fn(async (items: Record<string, unknown>) => {
			Object.assign(data, structuredClone(items));
		}),
		remove: vi.fn(async (key: string) => {
			delete data[key];
		}),
	};
}

async function loadWorker(
	options: WorkerOptions = {},
): Promise<WorkerEndpoint> {
	let listener: WorkerListener | undefined;
	let onRemoved: (tabId: number) => void = () => undefined;
	let onToolbarClicked: (tab: ToolbarTab) => void = () => undefined;
	let onCommand: (command: string) => void = () => undefined;
	let onNotificationClicked: (notificationId: string) => void = () => undefined;
	const notifications: Array<{ id: string; title: string; message: string }> =
		[];
	const badgeText = vi.fn();
	const title = vi.fn();
	const tabsCreate = vi.fn(async () => ({}));
	const session = options.session ?? createSessionArea();
	const tabsGet =
		options.tabsGet ??
		vi.fn(async (tabId: number) => ({
			id: tabId,
			url: "https://example.com/article",
		}));
	const settings = {
		server_url: "http://localhost:3500",
		default_tags: [],
		notify_on_success: true,
		notify_on_duplicate: true,
		max_blob_size_mb: 100,
		max_request_size_mb: 250,
		...options.settings,
	};
	const createNotification = vi.fn(
		(
			notificationId: string,
			notification: { title: string; message: string },
		) => {
			notifications.push({ id: notificationId, ...notification });
			if (options.notifications === "throws") {
				throw new Error("notification create threw");
			}
			if (options.notifications === "rejects") {
				return Promise.reject(new Error("notification create rejected"));
			}
			return Promise.resolve(notificationId);
		},
	);

	const api = {
		runtime: {
			onMessage: {
				addListener: (next: WorkerListener) => {
					listener = next;
				},
			},
			onConnect: { addListener: vi.fn() },
			getManifest: () => ({ manifest_version: 3 }),
			getPlatformInfo: vi.fn(async () => ({})),
			getURL: (path: string) => `chrome-extension://test/${path}`,
		},
		storage: {
			sync: { get: vi.fn(async () => ({ settings })) },
			session,
		},
		...(options.notifications === "absent"
			? {}
			: {
					notifications: {
						create: createNotification,
						onClicked: {
							addListener: (next: (notificationId: string) => void) => {
								onNotificationClicked = next;
							},
						},
					},
				}),
		tabs: {
			get: tabsGet,
			query: vi.fn(async () => [{ id: 7, url: "https://example.com/article" }]),
			sendMessage: vi.fn(async () => ({})),
			create: tabsCreate,
			onRemoved: {
				addListener: (next: (tabId: number) => void) => {
					onRemoved = next;
				},
			},
		},
		action: {
			setBadgeText: badgeText,
			setBadgeBackgroundColor: vi.fn(),
			setTitle: title,
			onClicked: {
				addListener: (next: (tab: ToolbarTab) => void) => {
					onToolbarClicked = next;
				},
			},
		},
		commands: {
			onCommand: {
				addListener: (next: (command: string) => void) => {
					onCommand = next;
				},
			},
		},
	};
	const namespace = options.namespace ?? "chrome";
	vi.stubGlobal(namespace, api);
	vi.stubGlobal(namespace === "chrome" ? "browser" : "chrome", undefined);

	await import("./service-worker");
	if (!listener) throw new Error("service worker did not register a listener");

	const dispatch = async (
		message: unknown,
		sender: { tab?: { id?: number }; frameId?: number } = {},
	) => {
		let response: unknown;
		let respond!: (value: unknown) => void;
		const responsePromise = new Promise<unknown>((resolve) => {
			respond = resolve;
		});
		const returned = listener?.(message, sender, (value) => {
			response = value;
			respond(value);
		});
		if (returned === true) return responsePromise;
		if (returned instanceof Promise) {
			const resolved = await returned;
			if (resolved !== undefined) response = resolved;
		}
		return response;
	};
	const query = (tabId = 7) => dispatch({ type: "capture_status", tabId });
	return {
		dispatch,
		query,
		removeTab: (tabId = 7) => onRemoved(tabId),
		clickToolbar: (tab = { id: 7, url: "https://example.com/article" }) =>
			onToolbarClicked(tab),
		runCommand: (command = "capture-page") => onCommand(command),
		clickNotification: (notificationId: string) =>
			onNotificationClicked(notificationId),
		notifications,
		badgeText,
		title,
		tabsCreate,
	};
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

async function startTransfer(worker: WorkerEndpoint, captureId = "capture-1") {
	await worker.dispatch({ type: "capture_start", tabId: 7 });
	await completeTransfer(worker.dispatch, captureId);
}

function statusMatching(
	phase: string,
	detail: string,
	additionalTags: string[] = [],
) {
	return expect.objectContaining({
		phase,
		detail,
		attemptId: expect.any(String),
		startedAt: expect.any(Number),
		updatedAt: expect.any(Number),
		additionalTags,
	});
}

async function currentStatus(
	worker: WorkerEndpoint,
	tabId = 7,
): Promise<CaptureStatus | null> {
	const response = await worker.query(tabId);
	// The harness dispatch boundary deliberately returns unknown like runtime messaging.
	const typedResponse = response as { status: CaptureStatus | null };
	return typedResponse.status;
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
	it("loads with only the browser namespace", async () => {
		await expect(loadWorker({ namespace: "browser" })).resolves.toBeDefined();
	});

	it("claims capturing before injection and returns the structured attempt", async () => {
		const injection = deferred<void>();
		dependencies.executeCaptureScript.mockReturnValueOnce(injection.promise);
		const worker = await loadWorker();

		const response = await worker.dispatch({ type: "capture_start", tabId: 7 });

		expect(dependencies.executeCaptureScript).toHaveBeenCalledWith(7);
		expect(response).toEqual({
			status: statusMatching("capturing", "reading the page…"),
		});
		expect(await worker.query()).toEqual(response);
		injection.resolve();
		await injection.promise;
	});

	it("normalizes capture_start additions and returns them in status", async () => {
		const worker = await loadWorker();

		const response = await worker.dispatch({
			type: "capture_start",
			tabId: 7,
			additionalTags: [" #reading ", "archive", "reading"],
		});

		expect(response).toEqual({
			status: statusMatching("capturing", "reading the page…", [
				"reading",
				"archive",
			]),
		});
		expect((await currentStatus(worker))?.additionalTags).toEqual([
			"reading",
			"archive",
		]);
	});

	it("atomically suppresses duplicate starts for the active tab", async () => {
		const injection = deferred<void>();
		dependencies.executeCaptureScript.mockReturnValue(injection.promise);
		const worker = await loadWorker();

		const [first, duplicate] = await Promise.all([
			worker.dispatch({ type: "capture_start", tabId: 7 }),
			worker.dispatch({ type: "capture_start", tabId: 7 }),
		]);

		expect(dependencies.executeCaptureScript).toHaveBeenCalledTimes(1);
		expect(duplicate).toEqual(first);
		injection.resolve();
	});

	it("does not let an active duplicate start replace its additions", async () => {
		const worker = await loadWorker();
		const first = await worker.dispatch({
			type: "capture_start",
			tabId: 7,
			additionalTags: ["reading"],
		});

		const duplicate = await worker.dispatch({
			type: "capture_start",
			tabId: 7,
			additionalTags: ["replacement"],
		});

		expect(duplicate).toEqual(first);
		expect((await currentStatus(worker))?.additionalTags).toEqual(["reading"]);
		expect(dependencies.executeCaptureScript).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			name: "toolbar",
			start: (worker: WorkerEndpoint) => worker.clickToolbar(),
		},
		{
			name: "command",
			start: (worker: WorkerEndpoint) => worker.runCommand(),
		},
	])("starts $name captures without additions", async ({ start }) => {
		const worker = await loadWorker();

		start(worker);

		await vi.waitFor(async () => {
			expect((await currentStatus(worker))?.additionalTags).toEqual([]);
		});
	});

	it("rehydrates a terminal status after the worker module restarts", async () => {
		const session = createSessionArea();
		dependencies.executeCaptureScript.mockRejectedValueOnce(
			new Error("Cannot access this page"),
		);
		const firstWorker = await loadWorker({ session });
		await firstWorker.dispatch({ type: "capture_start", tabId: 7 });
		await vi.waitFor(async () => {
			expect(await currentStatus(firstWorker)).toEqual(
				statusMatching(
					"error",
					"Capture could not start: Cannot access this page",
				),
			);
		});
		const beforeRestart = await firstWorker.query();
		await vi.waitFor(() => {
			expect(session.data.captureStatuses).toBeDefined();
		});

		vi.resetModules();
		const restartedWorker = await loadWorker({ session });

		expect(await restartedWorker.query()).toEqual(beforeRestart);
	});

	it("rehydrates processing as an interrupted terminal error", async () => {
		const session = createSessionArea();
		const firstWorker = await loadWorker({ session });
		await firstWorker.dispatch({ type: "capture_start", tabId: 7 });
		await firstWorker.dispatch(
			{ type: "capture_meta", captureId: "interrupted", metadata },
			{ tab: { id: 7 } },
		);
		expect((await currentStatus(firstWorker))?.phase).toBe("processing");
		await vi.waitFor(() => {
			const stored = session.data.captureStatuses as Record<
				string,
				CaptureStatus
			>;
			expect(stored["7"]?.phase).toBe("processing");
		});

		vi.resetModules();
		const restartedWorker = await loadWorker({ session });

		expect(await currentStatus(restartedWorker)).toEqual(
			statusMatching(
				"error",
				"Capture was interrupted when the extension worker restarted. Try again.",
			),
		);
	});

	it("normalizes persisted additions and repairs missing or malformed legacy data", async () => {
		const baseStatus = {
			phase: "done",
			detail: "Restored archive result.",
			startedAt: 10,
			updatedAt: 20,
		};
		const session = createSessionArea({
			captureStatuses: {
				"7": {
					...baseStatus,
					attemptId: "attempt-valid-additions",
					additionalTags: [" #reading ", 7, "Research", "reading"],
				},
				"8": {
					...baseStatus,
					attemptId: "attempt-legacy-missing",
				},
				"9": {
					...baseStatus,
					attemptId: "attempt-legacy-malformed",
					additionalTags: "reading",
				},
			},
		});
		const worker = await loadWorker({ session });

		expect((await currentStatus(worker))?.additionalTags).toEqual([
			"reading",
			"Research",
		]);
		expect((await currentStatus(worker, 8))?.additionalTags).toEqual([]);
		expect((await currentStatus(worker, 9))?.additionalTags).toEqual([]);
		await vi.waitFor(() => {
			const stored = session.data.captureStatuses as Record<
				string,
				CaptureStatus
			>;
			expect(stored["7"].additionalTags).toEqual(["reading", "Research"]);
			expect(stored["8"].additionalTags).toEqual([]);
			expect(stored["9"].additionalTags).toEqual([]);
		});
	});

	it("uses persisted additions when capture_meta arrives after a worker restart", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 14, 12));
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "created",
			vault_path: "archives/example/article.md",
			page_id: "page-1",
			blobs_stored: 1,
			blobs_deduped: 0,
		});
		const session = createSessionArea();
		const firstWorker = await loadWorker({ session });
		await firstWorker.dispatch({
			type: "capture_start",
			tabId: 7,
			additionalTags: ["reading"],
		});
		await vi.waitFor(() => {
			const stored = session.data.captureStatuses as Record<
				string,
				CaptureStatus
			>;
			expect(stored["7"].additionalTags).toEqual(["reading"]);
		});

		vi.resetModules();
		const restartedWorker = await loadWorker({ session });
		await completeTransfer(restartedWorker.dispatch, "capture-after-restart");
		await vi.waitFor(() =>
			expect(dependencies.ingestArchive).toHaveBeenCalledTimes(1),
		);

		expect(dependencies.ingestArchive.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tags: ["archive", "example.com", "2026-08", "reading"],
			}),
		);
	});

	it("bounds recovery time for a rehydrated capturing attempt", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const restored: CaptureStatus = {
			phase: "capturing",
			detail: "reading the page…",
			attemptId: "attempt-injected",
			startedAt: now,
			updatedAt: now,
			additionalTags: [],
		};
		const session = createSessionArea({
			captureStatuses: { "7": restored },
		});
		const worker = await loadWorker({ session });

		await vi.advanceTimersByTimeAsync(119_999);
		expect((await currentStatus(worker))?.phase).toBe("capturing");
		await vi.advanceTimersByTimeAsync(1);

		expect(await currentStatus(worker)).toEqual(
			statusMatching(
				"error",

				"Capture did not resume after the extension worker restarted. Try again.",
			),
		);
	});
	it("lets capture_meta resume an old capturing attempt that wakes the worker", async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const restored: CaptureStatus = {
			phase: "capturing",
			detail: "reading the page…",
			attemptId: "attempt-long-capture",
			startedAt: now - 300_000,
			updatedAt: now - 300_000,
			additionalTags: [],
		};
		const session = createSessionArea({
			captureStatuses: { "7": restored },
		});
		const worker = await loadWorker({ session });

		await worker.dispatch(
			{ type: "capture_meta", captureId: "long-capture", metadata },
			{ tab: { id: 7 } },
		);

		expect(await currentStatus(worker)).toEqual(
			expect.objectContaining({
				phase: "processing",
				attemptId: "attempt-long-capture",
			}),
		);
	});

	it("waits for session rehydration before answering capture_status", async () => {
		const restored: CaptureStatus = {
			phase: "done",
			detail: "Restored archive result.",
			attemptId: "attempt-restored",
			startedAt: 10,
			updatedAt: 20,
			additionalTags: [],
		};
		const session = createSessionArea();
		const readGate = deferred<Record<string, unknown>>();
		session.get.mockImplementationOnce(() => readGate.promise);
		const worker = await loadWorker({ session });
		let settled = false;
		const query = worker.query().then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		readGate.resolve({ captureStatuses: { "7": restored } });

		expect(await query).toEqual({ status: restored });
	});

	it("serializes persistence writes so an older status cannot land last", async () => {
		const session = createSessionArea();
		const firstWrite = deferred<void>();
		let writes = 0;
		session.set.mockImplementation(async (items: Record<string, unknown>) => {
			writes += 1;
			if (writes === 1) await firstWrite.promise;
			Object.assign(session.data, structuredClone(items));
		});
		dependencies.executeCaptureScript.mockRejectedValueOnce(
			new Error("blocked"),
		);
		const worker = await loadWorker({ session });
		const start = worker.dispatch({ type: "capture_start", tabId: 7 });
		await vi.waitFor(() => expect(writes).toBe(1));
		await Promise.resolve();
		expect(writes).toBe(1);

		firstWrite.resolve();
		await start;
		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				statusMatching("error", "Capture could not start: blocked"),
			);
		});
		await vi.waitFor(() => {
			const stored = session.data.captureStatuses as Record<
				string,
				CaptureStatus
			>;
			expect(stored["7"].phase).toBe("error");
		});
	});

	it("merges manifest tags in system, default, and addition order", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 14, 12));
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "created",
			vault_path: "archives/example/article.md",
			page_id: "page-1",
			blobs_stored: 1,
			blobs_deduped: 0,
		});
		const worker = await loadWorker({
			settings: { default_tags: ["archive", "default"] },
		});
		await worker.dispatch({
			type: "capture_start",
			tabId: 7,
			additionalTags: ["#default", "reading", "archive"],
		});

		await completeTransfer(worker.dispatch);
		await vi.waitFor(() =>
			expect(dependencies.ingestArchive).toHaveBeenCalledTimes(1),
		);

		expect(dependencies.ingestArchive.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tags: ["archive", "example.com", "2026-08", "default", "reading"],
			}),
		);
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
			phase: "done",
			detail: "A useful page was archived to archives/example/article.md.",
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
			phase: "duplicate",
			detail: "A useful page was already archived.",
		},
	])("publishes structured $name detail", async ({ result, phase, detail }) => {
		dependencies.ingestArchive.mockResolvedValueOnce(result);
		const worker = await loadWorker();

		await startTransfer(worker);

		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				statusMatching(phase, detail),
			);
		});
	});

	it("publishes the server conflict detail", async () => {
		dependencies.ingestArchive.mockRejectedValueOnce(
			new ArchiveConflictError({ vault_path: "archives/example/existing.md" }),
		);
		const worker = await loadWorker();

		await startTransfer(worker);

		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				statusMatching(
					"conflict",
					"A useful page changed since it was archived at archives/example/existing.md. The existing page was left untouched.",
				),
			);
		});
	});

	it("turns tabs.get rejection into a queryable terminal error", async () => {
		const worker = await loadWorker({
			tabsGet: vi.fn(async () => {
				throw new Error("tab disappeared");
			}),
		});

		await worker.dispatch({ type: "capture_start", tabId: 7 });

		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				statusMatching("error", "Capture could not start: tab disappeared"),
			);
		});
		expect(dependencies.executeCaptureScript).not.toHaveBeenCalled();
	});

	it("publishes CAPTURE_ABORT as terminal detail for its attempt", async () => {
		const worker = await loadWorker();
		await worker.dispatch({ type: "capture_start", tabId: 7 });
		await worker.dispatch(
			{ type: "capture_meta", captureId: "aborted", metadata },
			{ tab: { id: 7 } },
		);

		await worker.dispatch(
			{
				type: "capture_abort",
				captureId: "aborted",
				error: "message port closed",
			},
			{ tab: { id: 7 } },
		);

		expect(await currentStatus(worker)).toEqual(
			statusMatching("error", "Snapshot transfer aborted: message port closed"),
		);
	});

	it("deduplicates the generic error that follows CAPTURE_ABORT across a retry", async () => {
		const worker = await loadWorker();
		await worker.dispatch({ type: "capture_start", tabId: 7 });
		await worker.dispatch(
			{ type: "capture_meta", captureId: "aborted", metadata },
			{ tab: { id: 7 } },
		);
		await worker.dispatch(
			{ type: "capture_abort", captureId: "aborted", error: "port closed" },
			{ tab: { id: 7 } },
		);
		expect(worker.notifications).toHaveLength(1);

		await worker.dispatch({ type: "capture_start", tabId: 7 });
		const retry = await currentStatus(worker);
		await worker.dispatch(
			{ type: "capture_error", error: "port closed" },
			{ tab: { id: 7 } },
		);

		expect(await currentStatus(worker)).toEqual(retry);
		expect(retry?.phase).toBe("capturing");
		expect(worker.notifications).toHaveLength(1);
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
				await worker.dispatch({ type: "capture_start", tabId: 7 });
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
				await worker.dispatch({ type: "capture_start", tabId: 7 });
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
					{
						type: "capture_error",
						error: "The page produced an empty snapshot.",
					},
					{ tab: { id: 7 } },
				);
			},
			detail: "The page produced an empty snapshot.",
		},
	])(
		"publishes structured error detail for $name",
		async ({ trigger, detail }) => {
			const worker = await loadWorker();
			await trigger(worker);

			await vi.waitFor(async () => {
				expect(await currentStatus(worker)).toEqual(
					statusMatching("error", detail),
				);
			});
		},
	);

	it("ignores completion from an attempt superseded after a generic error", async () => {
		const ingest = deferred<{
			status: "created";
			vault_path: string;
			page_id: string;
			blobs_stored: number;
			blobs_deduped: number;
		}>();
		dependencies.ingestArchive.mockReturnValueOnce(ingest.promise);
		const worker = await loadWorker();
		await startTransfer(worker, "old-capture");
		await vi.waitFor(() =>
			expect(dependencies.ingestArchive).toHaveBeenCalled(),
		);
		await worker.dispatch(
			{ type: "capture_error", error: "old attempt lost its channel" },
			{ tab: { id: 7 } },
		);
		await worker.dispatch({ type: "capture_start", tabId: 7 });
		const newer = await currentStatus(worker);

		ingest.resolve({
			status: "created",
			vault_path: "archives/example/old.md",
			page_id: "old-page",
			blobs_stored: 0,
			blobs_deduped: 0,
		});
		await ingest.promise;
		await Promise.resolve();

		expect(await currentStatus(worker)).toEqual(newer);
		expect(newer?.phase).toBe("capturing");
	});

	it("ignores a stale capture ID and its inactivity timer after a retry", async () => {
		vi.useFakeTimers();
		const worker = await loadWorker();
		await worker.dispatch({ type: "capture_start", tabId: 7 });
		await worker.dispatch(
			{ type: "capture_meta", captureId: "stale", metadata },
			{ tab: { id: 7 } },
		);
		await worker.dispatch(
			{ type: "capture_error", error: "retryable failure" },
			{ tab: { id: 7 } },
		);
		await worker.dispatch({ type: "capture_start", tabId: 7 });
		const newer = await currentStatus(worker);

		await worker.dispatch(
			{
				type: "capture_chunk",
				captureId: "stale",
				index: 0,
				total: 1,
				text: "old snapshot",
			},
			{ tab: { id: 7 } },
		);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(dependencies.ingestArchive).not.toHaveBeenCalled();
		expect(await currentStatus(worker)).toEqual(newer);
	});

	it("tab removal clears session state and deferred completion cannot recreate it", async () => {
		const session = createSessionArea();
		const ingest = deferred<{
			status: "created";
			vault_path: string;
			page_id: string;
			blobs_stored: number;
			blobs_deduped: number;
		}>();
		dependencies.ingestArchive.mockReturnValueOnce(ingest.promise);
		const worker = await loadWorker({ session });
		await startTransfer(worker);
		await vi.waitFor(() =>
			expect(dependencies.ingestArchive).toHaveBeenCalled(),
		);

		worker.removeTab();
		await vi.waitFor(async () =>
			expect(await currentStatus(worker)).toBeNull(),
		);
		ingest.resolve({
			status: "created",
			vault_path: "archives/example/removed.md",
			page_id: "removed-page",
			blobs_stored: 0,
			blobs_deduped: 0,
		});
		await ingest.promise;
		await Promise.resolve();

		expect(await currentStatus(worker)).toBeNull();
		await vi.waitFor(() => {
			const stored = session.data.captureStatuses as Record<
				string,
				CaptureStatus
			>;
			expect(stored?.["7"]).toBeUndefined();
		});
	});

	it("old success badge timer cannot clear a newer attempt badge", async () => {
		vi.useFakeTimers();
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "created",
			vault_path: "archives/example/article.md",
			page_id: "page-1",
			blobs_stored: 1,
			blobs_deduped: 0,
		});
		const worker = await loadWorker();
		await startTransfer(worker);
		await vi.waitFor(async () => {
			expect((await currentStatus(worker))?.phase).toBe("done");
		});
		await worker.dispatch({ type: "capture_start", tabId: 7 });

		await vi.advanceTimersByTimeAsync(5_000);

		expect(worker.badgeText).toHaveBeenLastCalledWith({ text: "…", tabId: 7 });
		expect((await currentStatus(worker))?.phase).toBe("capturing");
	});

	it.each([
		{ name: "absent", notifications: "absent" },
		{ name: "synchronously throws", notifications: "throws" },
		{ name: "asynchronously rejects", notifications: "rejects" },
	] as const)(
		"keeps successful ingest done when the notification API is $name",
		async ({ notifications }) => {
			dependencies.ingestArchive.mockResolvedValueOnce({
				status: "created",
				vault_path: "archives/example/article.md",
				page_id: "page-1",
				blobs_stored: 1,
				blobs_deduped: 0,
			});
			const worker = await loadWorker({ notifications });

			await startTransfer(worker);
			await vi.waitFor(async () => {
				expect(["done", "error"]).toContain(
					(await currentStatus(worker))?.phase,
				);
			});

			expect(await currentStatus(worker)).toEqual(
				statusMatching(
					"done",
					"A useful page was archived to archives/example/article.md.",
				),
			);
			expect(worker.notifications).not.toContainEqual(
				expect.objectContaining({ title: "Archive Failed" }),
			);
		},
	);

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
			settings: { notify_on_success: false },
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
			settings: { notify_on_duplicate: false },
		},
	])("honors the $name notification opt-out", async ({ result, settings }) => {
		dependencies.ingestArchive.mockResolvedValueOnce(result);
		const worker = await loadWorker({ settings });

		await startTransfer(worker);
		await vi.waitFor(async () => {
			expect((await currentStatus(worker))?.phase).not.toBe("uploading");
		});

		expect(worker.notifications).toEqual([]);
	});

	it("keeps generic error notifications unconditional", async () => {
		dependencies.ingestArchive.mockRejectedValueOnce(
			new Error("vault offline"),
		);
		const worker = await loadWorker({
			settings: { notify_on_success: false, notify_on_duplicate: false },
		});

		await startTransfer(worker);
		await vi.waitFor(async () => {
			expect((await currentStatus(worker))?.phase).toBe("error");
		});

		expect(worker.notifications).toContainEqual(
			expect.objectContaining({
				title: "Archive Failed",
				message: "Error: vault offline",
			}),
		);
	});

	it("reports chunk progress while a transfer assembles", async () => {
		const worker = await loadWorker();
		await worker.dispatch({ type: "capture_start", tabId: 7 });
		await worker.dispatch(
			{ type: "capture_meta", captureId: "chunked", metadata },
			{ tab: { id: 7 } },
		);

		await worker.dispatch(
			{
				type: "capture_chunk",
				captureId: "chunked",
				index: 0,
				total: 2,
				text: "first half",
			},
			{ tab: { id: 7 } },
		);

		expect(await currentStatus(worker)).toEqual(
			expect.objectContaining({
				phase: "processing",
				chunksReceived: 1,
				chunksTotal: 2,
			}),
		);
	});

	it("done status carries the created page location", async () => {
		dependencies.ingestArchive.mockResolvedValueOnce({
			page_id: "pid-1",
			vault_path: "archive/example.com/x.md",
			blobs_stored: 1,
			blobs_deduped: 0,
			status: "created",
		});
		const worker = await loadWorker();

		await startTransfer(worker);

		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				expect.objectContaining({
					phase: "done",
					vaultPath: "archive/example.com/x.md",
					pageId: "pid-1",
				}),
			);
		});
	});

	it("duplicate status carries the existing page location", async () => {
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "already_exists",
			page_id: "pid-2",
			vault_path: "archive/example.com/y.md",
			blobs_stored: 0,
			blobs_deduped: 1,
		});
		const worker = await loadWorker();

		await startTransfer(worker);

		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				expect.objectContaining({
					phase: "duplicate",
					vaultPath: "archive/example.com/y.md",
					pageId: "pid-2",
				}),
			);
		});
	});

	it("conflict status carries the existing page location", async () => {
		dependencies.ingestArchive.mockRejectedValueOnce(
			new ArchiveConflictError({
				vault_path: "archive/example.com/z.md",
				page_id: "pid-3",
			}),
		);
		const worker = await loadWorker();

		await startTransfer(worker);

		await vi.waitFor(async () => {
			expect(await currentStatus(worker)).toEqual(
				expect.objectContaining({
					phase: "conflict",
					vaultPath: "archive/example.com/z.md",
					pageId: "pid-3",
				}),
			);
		});
	});

	it("rehydration keeps outcome fields and drops malformed ones", async () => {
		const session = createSessionArea({
			captureStatuses: {
				"7": {
					phase: "done",
					detail: "A useful page was archived to archive/example.com/kept.md.",
					attemptId: "attempt-outcome-kept",
					startedAt: 10,
					updatedAt: 20,
					additionalTags: [],
					vaultPath: "archive/example.com/kept.md",
					pageId: "pid-kept",
				},
				"8": {
					phase: "done",
					detail: "A useful page was archived to archive/example.com/still.md.",
					attemptId: "attempt-outcome-malformed",
					startedAt: 10,
					updatedAt: 20,
					additionalTags: [],
					chunksTotal: "two",
					vaultPath: "archive/example.com/still.md",
					pageId: "pid-still",
				},
			},
		});

		const worker = await loadWorker({ session });

		expect(await currentStatus(worker, 7)).toEqual(
			expect.objectContaining({
				phase: "done",
				vaultPath: "archive/example.com/kept.md",
				pageId: "pid-kept",
			}),
		);
		expect(await currentStatus(worker, 8)).toEqual(
			expect.objectContaining({
				phase: "done",
				vaultPath: "archive/example.com/still.md",
				pageId: "pid-still",
			}),
		);
		expect((await currentStatus(worker, 8))?.chunksTotal).toBeUndefined();
	});

	it("clicking a success notification opens the archived page once", async () => {
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "created",
			vault_path: "archive/example.com/x.md",
			page_id: "page-1",
			blobs_stored: 1,
			blobs_deduped: 0,
		});
		const worker = await loadWorker();

		await startTransfer(worker);
		await vi.waitFor(() => expect(worker.notifications).toHaveLength(1));
		const notificationId = worker.notifications[0]?.id;
		expect(notificationId).toBeTruthy();

		worker.clickNotification(notificationId as string);

		expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
		expect(worker.tabsCreate).toHaveBeenCalledWith({
			url: "http://localhost:3500/pages/archive/example.com/x.md",
		});
	});

	it("ignores a click for a notification id it never created", async () => {
		dependencies.ingestArchive.mockResolvedValueOnce({
			status: "created",
			vault_path: "archive/example.com/x.md",
			page_id: "page-1",
			blobs_stored: 1,
			blobs_deduped: 0,
		});
		const worker = await loadWorker();

		await startTransfer(worker);
		await vi.waitFor(() => expect(worker.notifications).toHaveLength(1));

		worker.clickNotification("clepsydra-unknown");

		expect(worker.tabsCreate).not.toHaveBeenCalled();
	});

	it("registers no click listener and does not throw when notifications are absent", async () => {
		await expect(
			loadWorker({ notifications: "absent" }),
		).resolves.toBeDefined();
	});
});
