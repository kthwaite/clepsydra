import type { CaptureMetaMessage, CaptureMetadata } from "#/content/capture";
import { ArchiveConflictError, ClepsydraClient } from "#/lib/api-client";
import {
	type CapturePhase,
	type CaptureStatus,
	badgeFor,
	describePhase,
	isTerminal,
} from "#/lib/badge";
import { CaptureQueue } from "#/lib/capture-queue";
import {
	currentMonthTag,
	mergeCaptureTags,
	normalizeCaptureTags,
} from "#/lib/capture-tags";
import {
	CAPTURE_ABORT,
	CAPTURE_CHUNK,
	type CaptureAbort,
	type CaptureChunk,
} from "#/lib/chunked-transfer";
import { sha256String } from "#/lib/hasher";
import { executeCaptureScript } from "#/lib/inject-capture";
import { describeInjectionFailure } from "#/lib/injection";
import { pageUrl } from "#/lib/page-url";
import {
	CAPTURE_INACTIVITY_TIMEOUT_MS,
	type CompletedTransfer,
	PendingTransferCoordinator,
} from "#/lib/pending-transfer";
import { RELAY_PORT_NAME, handleRelayFetchPort } from "#/lib/relay-fetch";
import { SingleFileRuntime } from "#/lib/singlefile-runtime";
import { convertArchiveHtml } from "#/lib/turndown-rules";
import type {
	ArchiveConflictDetail,
	ArchiveManifest,
	ExtensionSettings,
} from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";
import { webext } from "#/lib/webext";

/** Load settings from browser.storage.sync */
async function loadSettings(): Promise<ExtensionSettings> {
	const stored = await webext.storage.sync.get("settings");
	return { ...DEFAULT_SETTINGS, ...stored.settings };
}

/** Extract domain from URL */
function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "unknown";
	}
}

interface LegacyToolbarActionApi {
	onClicked?: {
		addListener: (callback: (tab: chrome.tabs.Tab) => void) => void;
	};
}

/** Build fallback markdown when Readability fails. */
function buildFallbackMarkdown(url: string, capturedAt: string): string {
	return [
		"> Automated reader-mode extraction failed for this page.",
		"> The captured snapshot is still archived and viewable.",
		"",
		`**URL:** ${url}`,
		`**Captured:** ${capturedAt}`,
	].join("\n");
}

/** Main pipeline: convert a completed capture and send it to the server. */
async function processCapture(
	metadata: CaptureMetadata,
	snapshotHtml: string,
	tabId: number | undefined,
	attemptId: string,
	additionalTags: readonly string[],
): Promise<void> {
	const settings = await loadSettings();
	if (!(await reportPhase(tabId, attemptId, "uploading"))) return;

	const client = new ClepsydraClient(settings.server_url);
	const capturedAt = new Date().toISOString();
	const domain = extractDomain(metadata.url);

	// Image URLs stay as Readability resolved them. The server rewrites them to
	// cas: references by joining on the original URLs SingleFile recorded in the
	// snapshot — it holds the only map, so it does the only rewriting.
	const markdownBody =
		metadata.article_html && metadata.article_text_length >= 200
			? convertArchiveHtml(metadata.article_html)
			: buildFallbackMarkdown(metadata.url, capturedAt);

	const manifest: ArchiveManifest = {
		url: metadata.url,
		canonical_url: metadata.canonical_url,
		domain,
		title: metadata.title,
		description: metadata.description,
		captured_at: capturedAt,
		content_hash: await sha256String(markdownBody),
		snapshot_html: snapshotHtml,
		markdown_body: markdownBody,
		tags: mergeCaptureTags(
			["archive", domain, currentMonthTag()],
			settings.default_tags,
			additionalTags,
		),
		byline: metadata.byline,
		site_name: metadata.site_name,
		published_time: metadata.published_time,
		lang: metadata.lang,
		excerpt: metadata.excerpt,
	};

	try {
		const response = await client.ingestArchive(manifest);

		if (response.status === "already_exists") {
			// A 409 conflict can only come from an active owner, so only this
			// branch needs to check for a binned prior capture: the server still
			// reports the (now nonexistent) original path, and neither the status
			// panel nor the notification may link to it.
			if (response.rubbish_item_id) {
				const detail = `${metadata.title} is already archived, in the Rubbish Bin.`;
				const applied = await reportPhase(
					tabId,
					attemptId,
					"duplicate",
					detail,
				);
				if (applied && settings.notify_on_duplicate) {
					showNotification("Already Archived", detail);
				}
			} else {
				const applied = await reportPhase(
					tabId,
					attemptId,
					"duplicate",
					`${metadata.title} was already archived.`,
					{ vaultPath: response.vault_path, pageId: response.page_id },
				);
				if (applied && settings.notify_on_duplicate) {
					showNotification(
						"Already Archived",
						`${metadata.title} was already saved.`,
						pageUrl(settings.server_url, response.vault_path),
					);
				}
			}
		} else {
			const applied = await reportPhase(
				tabId,
				attemptId,
				"done",
				`${metadata.title} was archived to ${response.vault_path}.`,
				{ vaultPath: response.vault_path, pageId: response.page_id },
			);
			if (applied && settings.notify_on_success) {
				showNotification(
					"Page Archived",
					`${metadata.title} → ${response.vault_path}`,
					pageUrl(settings.server_url, response.vault_path),
				);
			}
		}
	} catch (err) {
		if (err instanceof ArchiveConflictError) {
			const detail = describeConflict(metadata.title, err);
			const conflictDetail = err.detail as ArchiveConflictDetail | undefined;
			if (
				await reportPhase(tabId, attemptId, "conflict", detail, {
					vaultPath: conflictDetail?.vault_path,
					pageId: conflictDetail?.page_id,
				})
			) {
				showNotification(
					"Content Changed",
					detail,
					conflictDetail?.vault_path
						? pageUrl(settings.server_url, conflictDetail.vault_path)
						: undefined,
				);
			}
		} else {
			const detail = String(err);
			if (await reportPhase(tabId, attemptId, "error", detail)) {
				// Error notifications are deliberately unconditional.
				showNotification("Archive Failed", detail);
			}
		}
	}
}

/**
 * The server already tells us where the previous capture lives; saying so is
 * the difference between an actionable notification and a shrug.
 */
function describeConflict(title: string, err: ArchiveConflictError): string {
	const detail = err.detail as ArchiveConflictDetail | undefined;
	const path = detail?.vault_path;
	return path
		? `${title} changed since it was archived at ${path}. The existing page was left untouched.`
		: `${title} has changed since last capture. The existing page was left untouched.`;
}

let notificationSequence = 0;

/**
 * The MV3 worker is terminated after ~30s idle; a click on a notification
 * that outlived that can wake a fresh worker whose module scope has no
 * memory of what was shown. Rather than persist a lookup table through that
 * restart, the id itself carries the target URL, so `onClicked` below can
 * decode it with no state at all. A url-derived id also means re-capturing a
 * page replaces its earlier notification instead of stacking a new one.
 */
function showNotification(
	title: string,
	message: string,
	targetUrl?: string,
): void {
	const notifications = webext.notifications;
	if (!notifications?.create) return;
	let notificationId: string;
	if (targetUrl) {
		notificationId = `clepsydra:${encodeURIComponent(targetUrl)}`;
	} else {
		notificationSequence += 1;
		notificationId = `clepsydra:seq:${notificationSequence}`;
	}

	try {
		// The worker lives at /background/, so a relative icon path resolves to
		// /background/icons/... and Chrome rejects the whole notification with
		// "Unable to download all specified images". Always use an extension URL.
		void Promise.resolve(
			notifications.create(notificationId, {
				type: "basic",
				iconUrl: webext.runtime.getURL("icons/icon-128.png"),
				title,
				message,
			}),
		).catch(() => {
			// The id carries no separate state, so there is nothing to clean up.
		});
	} catch {
		// Some notification implementations throw before returning a promise.
	}
}

webext.notifications?.onClicked?.addListener((notificationId: string) => {
	if (!notificationId.startsWith("clepsydra:")) return;
	if (notificationId.startsWith("clepsydra:seq:")) return;
	const url = decodeURIComponent(notificationId.slice("clepsydra:".length));
	void webext.tabs.create({ url });
});

const legacyWebext = webext as typeof chrome & {
	browserAction?: LegacyToolbarActionApi;
};

interface ToolbarBadgeApi {
	setBadgeText: (details: { text: string; tabId?: number }) => void;
	setBadgeBackgroundColor: (details: {
		color: string;
		tabId?: number;
	}) => void;
	setTitle: (details: { title: string; tabId?: number }) => void;
}

function badgeApi(): ToolbarBadgeApi | undefined {
	const api = webext.action ?? legacyWebext.browserAction;
	return api as unknown as ToolbarBadgeApi | undefined;
}

const STATUS_STORAGE_KEY = "captureStatuses";
const CAPTURING_RECOVERY_MS = 120_000;
const INTERRUPTED_CAPTURE_DETAIL =
	"Capture was interrupted when the extension worker restarted. Try again.";
const CAPTURING_RECOVERY_DETAIL =
	"Capture did not resume after the extension worker restarted. Try again.";
const ABORT_ERROR_DEDUPLICATION_MS = 5_000;

interface SessionStatusStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

interface CaptureAttempt {
	tabId: number;
	attemptId: string;
	additionalTags: string[];
}

interface RecentAbort {
	error: string;
	expiresAt: number;
}

interface AttemptClaim {
	status: CaptureStatus;
	started: boolean;
	persisted: Promise<void>;
}

/** Latest per-tab status plus capture IDs bound to the attempt that created them. */
const statuses = new Map<number, CaptureStatus>();
const captureAttempts = new Map<string, CaptureAttempt>();
const recentAborts = new Map<number, RecentAbort>();
const sessionStatusStorage = webext.storage.session as unknown as
	| SessionStatusStorage
	| undefined;
let persistenceTail: Promise<void> = Promise.resolve();
let attemptSequence = 0;

function isCapturePhase(value: unknown): value is CapturePhase {
	switch (value) {
		case "capturing":
		case "processing":
		case "uploading":
		case "done":
		case "duplicate":
		case "conflict":
		case "error":
			return true;
		default:
			return false;
	}
}

type StoredCaptureStatus = Omit<
	CaptureStatus,
	"additionalTags" | "chunksReceived" | "chunksTotal" | "vaultPath" | "pageId"
> & {
	additionalTags?: unknown;
	chunksReceived?: unknown;
	chunksTotal?: unknown;
	vaultPath?: unknown;
	pageId?: unknown;
};

function isCaptureStatus(value: unknown): value is StoredCaptureStatus {
	if (!value || typeof value !== "object") return false;
	if (!("phase" in value) || !isCapturePhase(value.phase)) return false;
	return (
		"detail" in value &&
		typeof value.detail === "string" &&
		"attemptId" in value &&
		typeof value.attemptId === "string" &&
		value.attemptId.length > 0 &&
		"startedAt" in value &&
		typeof value.startedAt === "number" &&
		Number.isFinite(value.startedAt) &&
		"updatedAt" in value &&
		typeof value.updatedAt === "number" &&
		Number.isFinite(value.updatedAt)
	);
}

const optionalString = (v: unknown): v is string | undefined =>
	v === undefined || typeof v === "string";
const optionalCount = (v: unknown): v is number | undefined =>
	v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

async function rehydrateStatuses(): Promise<void> {
	if (!sessionStatusStorage) return;
	const stored = await sessionStatusStorage.get(STATUS_STORAGE_KEY);
	const rawStatuses = stored[STATUS_STORAGE_KEY];
	if (!rawStatuses || typeof rawStatuses !== "object") return;

	let repaired = false;
	for (const [rawTabId, rawStatus] of Object.entries(rawStatuses)) {
		const tabId = Number(rawTabId);
		if (!Number.isSafeInteger(tabId) || !isCaptureStatus(rawStatus)) continue;

		const additionalTags = normalizeCaptureTags(rawStatus.additionalTags);
		const rawAdditionalTags = rawStatus.additionalTags;
		if (
			!Array.isArray(rawAdditionalTags) ||
			rawAdditionalTags.length !== additionalTags.length ||
			rawAdditionalTags.some((value, index) => value !== additionalTags[index])
		) {
			repaired = true;
		}
		let status: CaptureStatus = {
			phase: rawStatus.phase,
			detail: rawStatus.detail,
			attemptId: rawStatus.attemptId,
			startedAt: rawStatus.startedAt,
			updatedAt: rawStatus.updatedAt,
			additionalTags,
		};
		if (optionalCount(rawStatus.chunksReceived)) {
			if (rawStatus.chunksReceived !== undefined) {
				status.chunksReceived = rawStatus.chunksReceived;
			}
		} else {
			repaired = true;
		}
		if (optionalCount(rawStatus.chunksTotal)) {
			if (rawStatus.chunksTotal !== undefined) {
				status.chunksTotal = rawStatus.chunksTotal;
			}
		} else {
			repaired = true;
		}
		if (optionalString(rawStatus.vaultPath)) {
			if (rawStatus.vaultPath !== undefined) {
				status.vaultPath = rawStatus.vaultPath;
			}
		} else {
			repaired = true;
		}
		if (optionalString(rawStatus.pageId)) {
			if (rawStatus.pageId !== undefined) {
				status.pageId = rawStatus.pageId;
			}
		} else {
			repaired = true;
		}
		if (status.phase === "processing" || status.phase === "uploading") {
			status = {
				...status,
				phase: "error",
				detail: INTERRUPTED_CAPTURE_DETAIL,
				updatedAt: Math.max(Date.now(), status.updatedAt + 1),
			};
			status.chunksReceived = undefined;
			status.chunksTotal = undefined;
			repaired = true;
		}
		statuses.set(tabId, status);
	}
	if (repaired) await persistStatuses();
}

const statusReady = rehydrateStatuses().catch(() => {
	// Session storage is an MV3 durability improvement, not a capture dependency.
});

function persistStatuses(): Promise<void> {
	if (!sessionStatusStorage) return Promise.resolve();
	const snapshot = Object.fromEntries(
		Array.from(statuses, ([tabId, status]) => [
			String(tabId),
			{ ...status, additionalTags: [...status.additionalTags] },
		]),
	);
	const write = persistenceTail.then(
		() => sessionStatusStorage.set({ [STATUS_STORAGE_KEY]: snapshot }),
		() => sessionStatusStorage.set({ [STATUS_STORAGE_KEY]: snapshot }),
	);
	persistenceTail = write.catch(() => {
		// Keep later revisions writable after one transient storage failure.
	});
	return write.catch(() => {
		// Capture remains functional in memory if session storage is unavailable.
	});
}

function nextAttemptId(): string {
	attemptSequence += 1;
	return `${Date.now().toString(36)}-${attemptSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function nextStatusTimestamp(previous?: CaptureStatus): number {
	const now = Date.now();
	return previous ? Math.max(now, previous.updatedAt + 1) : now;
}

/** Drive the toolbar badge without changing the retained status revision. */
function applyBadge(tabId: number, status: CaptureStatus): void {
	const api = badgeApi();
	if (!api) return;
	const badge = badgeFor(status.phase);
	try {
		api.setBadgeText({ text: badge.text, tabId });
		api.setBadgeBackgroundColor({ color: badge.color, tabId });
		api.setTitle({ title: badge.title, tabId });
	} catch {
		// Badge APIs are unavailable on some platforms (e.g. mobile Firefox).
		return;
	}

	if (!isTerminal(status.phase) || badge.clearAfterMs === null) return;
	const clearAt = status.updatedAt + badge.clearAfterMs;
	setTimeout(
		() => {
			const current = statuses.get(tabId);
			if (
				current?.attemptId !== status.attemptId ||
				current.updatedAt !== status.updatedAt
			) {
				return;
			}
			try {
				api.setBadgeText({ text: "", tabId });
				api.setTitle({ title: "", tabId });
			} catch {
				// ignored
			}
		},
		Math.max(0, clearAt - Date.now()),
	);
}

function scheduleCapturingRecovery(tabId: number, status: CaptureStatus): void {
	if (status.phase !== "capturing") return;
	setTimeout(() => {
		const current = statuses.get(tabId);
		if (
			current?.attemptId !== status.attemptId ||
			current.updatedAt !== status.updatedAt ||
			current.phase !== "capturing"
		) {
			return;
		}
		void reportPhase(
			tabId,
			status.attemptId,
			"error",
			CAPTURING_RECOVERY_DETAIL,
		).then((applied) => {
			if (applied) {
				showNotification("Capture Failed", CAPTURING_RECOVERY_DETAIL);
			}
		});
	}, CAPTURING_RECOVERY_MS);
}

void statusReady.then(() => {
	for (const [tabId, status] of statuses) {
		applyBadge(tabId, status);
		scheduleCapturingRecovery(tabId, status);
	}
});

function claimAttempt(
	tabId: number,
	additionalTags: readonly string[],
): AttemptClaim {
	const current = statuses.get(tabId);
	if (current && !isTerminal(current.phase)) {
		return { status: current, started: false, persisted: Promise.resolve() };
	}

	const startedAt = Date.now();
	const status: CaptureStatus = {
		phase: "capturing",
		detail: describePhase("capturing"),
		attemptId: nextAttemptId(),
		startedAt,
		updatedAt: startedAt,
		additionalTags: [...additionalTags],
	};
	statuses.set(tabId, status);
	applyBadge(tabId, status);
	return { status, started: true, persisted: persistStatuses() };
}

type CaptureStatusExtra = Partial<
	Pick<CaptureStatus, "chunksReceived" | "chunksTotal" | "vaultPath" | "pageId">
>;

async function reportPhase(
	tabId: number | undefined,
	attemptId: string,
	phase: CapturePhase,
	detail: string = describePhase(phase),
	extra: CaptureStatusExtra = {},
): Promise<boolean> {
	if (tabId === undefined) return false;
	const current = statuses.get(tabId);
	if (!current || current.attemptId !== attemptId) return false;

	const status: CaptureStatus = {
		...current,
		...extra,
		phase,
		detail,
		updatedAt: nextStatusTimestamp(current),
	};
	if (phase !== "processing") {
		status.chunksReceived = undefined;
		status.chunksTotal = undefined;
	}
	if (phase !== "done" && phase !== "duplicate" && phase !== "conflict") {
		if (extra.vaultPath === undefined) status.vaultPath = undefined;
		if (extra.pageId === undefined) status.pageId = undefined;
	}
	statuses.set(tabId, status);
	applyBadge(tabId, status);
	await persistStatuses();
	const latest = statuses.get(tabId);
	return (
		latest?.attemptId === status.attemptId &&
		latest.updatedAt === status.updatedAt
	);
}

async function reportUnconditionalError(
	tabId: number | undefined,
	detail: string,
): Promise<boolean> {
	if (tabId === undefined) return false;
	const current = statuses.get(tabId);
	if (current?.phase === "error" && current.detail === detail) return false;
	const claim = current ? null : claimAttempt(tabId, []);
	if (claim) await claim.persisted;
	const attemptId = statuses.get(tabId)?.attemptId;
	return attemptId ? reportPhase(tabId, attemptId, "error", detail) : false;
}

function rememberAbortError(tabId: number, error: string): void {
	const marker = {
		error,
		expiresAt: Date.now() + ABORT_ERROR_DEDUPLICATION_MS,
	};
	recentAborts.set(tabId, marker);
	setTimeout(() => {
		if (recentAborts.get(tabId) === marker) recentAborts.delete(tabId);
	}, ABORT_ERROR_DEDUPLICATION_MS);
}

function consumeMatchingAbortError(
	tabId: number | undefined,
	error: string,
): boolean {
	if (tabId === undefined) return false;
	const marker = recentAborts.get(tabId);
	if (!marker) return false;
	if (marker.expiresAt < Date.now()) {
		recentAborts.delete(tabId);
		return false;
	}
	if (marker.error !== error) return false;
	recentAborts.delete(tabId);
	return true;
}

function bindCaptureToCurrentAttempt(
	tabId: number | undefined,
	captureId: string,
): CaptureAttempt | null {
	if (tabId === undefined) return null;
	const current = statuses.get(tabId);
	const existing = captureAttempts.get(captureId);
	if (existing) {
		return existing.tabId === tabId &&
			current?.attemptId === existing.attemptId &&
			!isTerminal(current.phase)
			? existing
			: null;
	}
	if (!current || isTerminal(current.phase)) return null;
	const captureAttempt: CaptureAttempt = {
		tabId,
		attemptId: current.attemptId,
		additionalTags: [...current.additionalTags],
	};
	captureAttempts.set(captureId, captureAttempt);
	return captureAttempt;
}

/**
 * Any extension API call resets the MV3 idle timer. MV2 background pages are
 * not suspended, so inability to call it there is benign.
 */
function keepServiceWorkerAlive(): void {
	try {
		void Promise.resolve(webext.runtime.getPlatformInfo()).catch(() => {});
	} catch {
		// ignored
	}
}

/**
 * URL-level suppression remains useful across tabs after the per-tab attempt
 * has already prevented reinjection.
 */
const captureQueue = new CaptureQueue({
	keepAlive: keepServiceWorkerAlive,
});

/** Snapshot chunks, metadata, and inactivity timers in flight. */
const pendingTransfers = new PendingTransferCoordinator<CaptureMetadata>({
	keepAlive: keepServiceWorkerAlive,
	onExpire: (captureId, tabId) => {
		const captureAttempt = captureAttempts.get(captureId);
		if (!captureAttempt || captureAttempt.tabId !== tabId) return;
		const detail = `Snapshot transfer ${captureId} expired after ${CAPTURE_INACTIVITY_TIMEOUT_MS / 1_000} seconds of inactivity.`;
		void reportPhase(tabId, captureAttempt.attemptId, "error", detail).then(
			(applied) => {
				if (applied) showNotification("Capture Failed", detail);
			},
		);
	},
});

const singleFileRuntime = new SingleFileRuntime((tabId, message, options) =>
	webext.tabs.sendMessage(tabId, message, options),
);

type WorkerMessage =
	| CaptureMetaMessage
	| CaptureChunk
	| CaptureAbort
	| { type: "capture_error"; error: string }
	| { type: "capture_start"; tabId: number; additionalTags?: unknown }
	| { type: "capture_status"; tabId: number };

async function injectClaimedCapture(
	tab: chrome.tabs.Tab,
	attemptId: string,
): Promise<void> {
	if (tab.id === undefined || statuses.get(tab.id)?.attemptId !== attemptId) {
		return;
	}
	try {
		await executeCaptureScript(tab.id);
	} catch (err) {
		const detail = describeInjectionFailure(tab.url, err);
		if (await reportPhase(tab.id, attemptId, "error", detail)) {
			showNotification("Capture Failed", detail);
		}
	}
}

async function fetchTabAndInject(
	tabId: number,
	attemptId: string,
): Promise<void> {
	try {
		const tab = await webext.tabs.get(tabId);
		await injectClaimedCapture(tab, attemptId);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const detail = `Capture could not start: ${reason}`;
		if (await reportPhase(tabId, attemptId, "error", detail)) {
			showNotification("Capture Failed", detail);
		}
	}
}

async function beginCaptureForTabId(
	tabId: number,
	additionalTags: unknown,
): Promise<CaptureStatus> {
	await statusReady;
	const claim = claimAttempt(tabId, normalizeCaptureTags(additionalTags));
	if (claim.started) void fetchTabAndInject(tabId, claim.status.attemptId);
	await claim.persisted;
	return statuses.get(tabId) ?? claim.status;
}

async function beginCaptureForTab(tab: chrome.tabs.Tab): Promise<void> {
	await statusReady;
	if (tab.id === undefined) return;
	const claim = claimAttempt(tab.id, []);
	if (claim.started) void injectClaimedCapture(tab, claim.status.attemptId);
	await claim.persisted;
}

async function handleWorkerMessage(
	workerMessage: WorkerMessage,
	sender: chrome.runtime.MessageSender,
): Promise<unknown> {
	await statusReady;

	if (workerMessage.type === "capture_status") {
		return { status: statuses.get(workerMessage.tabId) ?? null };
	}

	if (workerMessage.type === "capture_start") {
		return {
			status: await beginCaptureForTabId(
				workerMessage.tabId,
				workerMessage.additionalTags,
			),
		};
	}

	const tabId = sender.tab?.id;

	if (workerMessage.type === "capture_meta") {
		const captureAttempt = bindCaptureToCurrentAttempt(
			tabId,
			workerMessage.captureId,
		);
		if (!captureAttempt) return undefined;
		if (!(await reportPhase(tabId, captureAttempt.attemptId, "processing"))) {
			return undefined;
		}
		pendingTransfers.acceptMetadata(
			workerMessage.captureId,
			workerMessage.metadata,
			tabId,
		);
		return undefined;
	}

	if (workerMessage.type === CAPTURE_CHUNK) {
		const captureAttempt = bindCaptureToCurrentAttempt(
			tabId,
			workerMessage.captureId,
		);
		if (!captureAttempt) return undefined;
		const { attemptId } = captureAttempt;
		let completed: CompletedTransfer<CaptureMetadata> | null;
		try {
			completed = pendingTransfers.acceptChunk(workerMessage, tabId);
		} catch (error) {
			const detail = `Malformed snapshot transfer: ${String(error)}`;
			if (await reportPhase(tabId, attemptId, "error", detail)) {
				showNotification("Capture Failed", detail);
			}
			return undefined;
		}
		if (completed === null) {
			if (statuses.get(tabId ?? -1)?.attemptId === attemptId) {
				void reportPhase(tabId, attemptId, "processing", undefined, {
					chunksReceived: workerMessage.index + 1,
					chunksTotal: workerMessage.total,
				});
			}
			return undefined;
		}
		if (statuses.get(tabId ?? -1)?.attemptId !== attemptId) {
			return undefined;
		}

		const { metadata, snapshotHtml, tabId: completedTabId } = completed;
		if (!metadata) {
			const detail = "Capture metadata was lost in transit.";
			if (await reportPhase(completedTabId, attemptId, "error", detail)) {
				showNotification("Archive Failed", detail);
			}
			return undefined;
		}

		const started = captureQueue.run(metadata.url, () =>
			processCapture(
				metadata,
				snapshotHtml,
				completedTabId,
				attemptId,
				captureAttempt.additionalTags,
			).catch(async (err) => {
				const detail = String(err);
				if (await reportPhase(completedTabId, attemptId, "error", detail)) {
					showNotification("Archive Failed", detail);
				}
			}),
		);
		if (!started) {
			const detail = `${metadata.title} is already being archived.`;
			if (await reportPhase(completedTabId, attemptId, "duplicate", detail)) {
				showNotification("Capture In Progress", detail);
			}
		}
		return undefined;
	}

	if (workerMessage.type === CAPTURE_ABORT) {
		const captureAttempt = bindCaptureToCurrentAttempt(
			tabId,
			workerMessage.captureId,
		);
		pendingTransfers.abort(workerMessage.captureId);
		if (!captureAttempt || tabId === undefined) return undefined;
		const { attemptId } = captureAttempt;
		rememberAbortError(tabId, workerMessage.error);
		const detail = `Snapshot transfer ${workerMessage.captureId}: ${workerMessage.error}`;
		if (await reportPhase(tabId, attemptId, "error", detail)) {
			showNotification("Capture Failed", detail);
		}
		return undefined;
	}

	if (workerMessage.type === "capture_error") {
		if (consumeMatchingAbortError(tabId, workerMessage.error)) return undefined;
		if (await reportUnconditionalError(tabId, workerMessage.error)) {
			showNotification("Capture Failed", workerMessage.error);
		}
	}
	return undefined;
}

function respondWhenReady(
	response: Promise<unknown>,
	sendResponse: (response?: unknown) => void,
): true {
	void response.then(sendResponse, (error) => {
		sendResponse({ error: String(error) });
	});
	return true;
}

webext.runtime.onConnect.addListener((port) => {
	if (port.name === RELAY_PORT_NAME) {
		handleRelayFetchPort(port);
	}
});

webext.runtime.onMessage.addListener(
	(
		message: unknown,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	): boolean | undefined | Promise<unknown> => {
		const singleFileResponse = singleFileRuntime.handleMessage(message, sender);
		if (singleFileResponse) return singleFileResponse;
		const workerMessage = message as WorkerMessage;
		switch (workerMessage.type) {
			case "capture_status":
			case "capture_start":
			case "capture_meta":
			case CAPTURE_CHUNK:
			case CAPTURE_ABORT:
			case "capture_error":
				return respondWhenReady(
					handleWorkerMessage(workerMessage, sender),
					sendResponse,
				);
			default:
				return undefined;
		}
	},
);

webext.tabs.onRemoved?.addListener((tabId) => {
	pendingTransfers.removeTab(tabId);
	singleFileRuntime.removeTab(tabId);
	recentAborts.delete(tabId);
	void statusReady.then(async () => {
		statuses.delete(tabId);
		for (const [captureId, captureAttempt] of captureAttempts) {
			if (captureAttempt.tabId === tabId) captureAttempts.delete(captureId);
		}
		await persistStatuses();
	});
});

const toolbarAction = webext.action ?? legacyWebext.browserAction;
if (toolbarAction?.onClicked) {
	toolbarAction.onClicked.addListener((tab) => {
		void beginCaptureForTab(tab);
	});
}

webext.commands.onCommand.addListener((command) => {
	if (command === "capture-page") {
		void webext.tabs
			.query({ active: true, currentWindow: true })
			.then((tabs) => {
				const tab = tabs[0];
				if (tab) void beginCaptureForTab(tab);
			});
	}
});
