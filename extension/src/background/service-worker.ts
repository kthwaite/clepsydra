import type { CaptureMetaMessage, CaptureMetadata } from "#/content/capture";
import { ArchiveConflictError, ClepsydraClient } from "#/lib/api-client";
import { type CapturePhase, badgeFor, isTerminal } from "#/lib/badge";
import { CaptureQueue } from "#/lib/capture-queue";
import {
	CAPTURE_ABORT,
	CAPTURE_CHUNK,
	type CaptureAbort,
	type CaptureChunk,
} from "#/lib/chunked-transfer";
import { sha256String } from "#/lib/hasher";
import { executeCaptureScript } from "#/lib/inject-capture";
import { describeInjectionFailure } from "#/lib/injection";
import {
	CAPTURE_INACTIVITY_TIMEOUT_MS,
	type CompletedTransfer,
	PendingTransferCoordinator,
} from "#/lib/pending-transfer";
import { RELAY_PORT_NAME, handleRelayFetchPort } from "#/lib/relay-fetch";
import { convertArchiveHtml } from "#/lib/turndown-rules";
import type {
	ArchiveConflictDetail,
	ArchiveManifest,
	ExtensionSettings,
} from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";

/** Load settings from browser.storage.sync */
async function loadSettings(): Promise<ExtensionSettings> {
	const stored = await chrome.storage.sync.get("settings");
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

/** Format current month as YYYY-MM */
function currentMonthTag(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
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
): Promise<void> {
	const settings = await loadSettings();
	const client = new ClepsydraClient(settings.server_url);
	const capturedAt = new Date().toISOString();
	const domain = extractDomain(metadata.url);

	reportPhase(tabId, "uploading");

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
		tags: ["archive", domain, currentMonthTag(), ...settings.default_tags],
		byline: metadata.byline,
		site_name: metadata.site_name,
		published_time: metadata.published_time,
		lang: metadata.lang,
		excerpt: metadata.excerpt,
	};

	try {
		const response = await client.ingestArchive(manifest);

		if (response.status === "already_exists") {
			reportPhase(tabId, "duplicate");
			if (settings.notify_on_duplicate) {
				showNotification(
					"Already Archived",
					`${metadata.title} was already saved.`,
				);
			}
		} else {
			reportPhase(tabId, "done");
			if (settings.notify_on_success) {
				showNotification(
					"Page Archived",
					`${metadata.title} → ${response.vault_path}`,
				);
			}
		}
	} catch (err) {
		if (err instanceof ArchiveConflictError) {
			reportPhase(tabId, "conflict");
			showNotification(
				"Content Changed",
				describeConflict(metadata.title, err),
			);
		} else {
			reportPhase(tabId, "error");
			showNotification("Archive Failed", String(err));
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

function showNotification(title: string, message: string): void {
	// The worker lives at /background/, so a relative icon path resolves to
	// /background/icons/... and Chrome rejects the whole notification with
	// "Unable to download all specified images". Always use an extension URL.
	void Promise.resolve(
		chrome.notifications.create({
			type: "basic",
			iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
			title,
			message,
		}),
	).catch(() => {
		// Notifications are best-effort; the badge is the reliable signal.
	});
}

const legacyChrome = chrome as typeof chrome & {
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
	const api = chrome.action ?? legacyChrome.browserAction;
	return api as unknown as ToolbarBadgeApi | undefined;
}

/** Where each tab is in its capture, so the popup can report it. */
const phases = new Map<number, CapturePhase>();

/**
 * Drive the toolbar badge. This is the primary progress signal: notifications
 * only fire at the end, and can be suppressed by the OS entirely.
 */
function reportPhase(tabId: number | undefined, phase: CapturePhase): void {
	if (tabId === undefined) return;
	phases.set(tabId, phase);

	const api = badgeApi();
	if (!api) return;
	const badge = badgeFor(phase);
	try {
		api.setBadgeText({ text: badge.text, tabId });
		api.setBadgeBackgroundColor({ color: badge.color, tabId });
		api.setTitle({ title: badge.title, tabId });
	} catch {
		// Badge APIs are unavailable on some platforms (e.g. mobile Firefox).
		return;
	}

	if (isTerminal(phase) && badge.clearAfterMs !== null) {
		setTimeout(() => {
			if (phases.get(tabId) !== phase) return;
			phases.delete(tabId);
			try {
				api.setBadgeText({ text: "", tabId });
				api.setTitle({ title: "", tabId });
			} catch {
				// ignored
			}
		}, badge.clearAfterMs);
	}
}

/**
 * Any extension API call resets the MV3 idle timer. MV2 background pages are
 * not suspended, so inability to call it there is benign.
 */
function keepServiceWorkerAlive(): void {
	try {
		void Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => {});
	} catch {
		// ignored
	}
}

/**
 * Guards every capture: suppresses duplicates for a URL already being captured,
 * and keeps the service worker alive while asynchronous work is outstanding.
 */
const captureQueue = new CaptureQueue({
	keepAlive: keepServiceWorkerAlive,
});

/** Snapshot chunks, metadata, and inactivity timers in flight. */
const pendingTransfers = new PendingTransferCoordinator<CaptureMetadata>({
	keepAlive: keepServiceWorkerAlive,
	onExpire: (captureId, tabId) => {
		reportPhase(tabId, "error");
		showNotification(
			"Capture Failed",
			`Snapshot transfer ${captureId} expired after ${CAPTURE_INACTIVITY_TIMEOUT_MS / 1_000} seconds of inactivity.`,
		);
	},
});

type WorkerMessage =
	| CaptureMetaMessage
	| CaptureChunk
	| CaptureAbort
	| { type: "capture_error"; error: string }
	| { type: "capture_status"; tabId: number };

chrome.runtime.onConnect.addListener((port) => {
	if (port.name === RELAY_PORT_NAME) {
		handleRelayFetchPort(port);
	}
});

chrome.runtime.onMessage.addListener(
	(
		message: WorkerMessage,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	): boolean | undefined => {
		if (message.type === "capture_status") {
			// Answered synchronously, so no need to hold the channel open.
			sendResponse({ phase: phases.get(message.tabId) ?? null });
			return undefined;
		}

		const tabId = sender.tab?.id;

		if (message.type === "capture_meta") {
			reportPhase(tabId, "processing");
			pendingTransfers.acceptMetadata(
				message.captureId,
				message.metadata,
				tabId,
			);
			return undefined;
		}

		if (message.type === CAPTURE_CHUNK) {
			let completed: CompletedTransfer<CaptureMetadata> | null;
			try {
				completed = pendingTransfers.acceptChunk(message, tabId);
			} catch (error) {
				reportPhase(tabId, "error");
				showNotification(
					"Capture Failed",
					`Malformed snapshot transfer: ${String(error)}`,
				);
				return undefined;
			}
			if (completed === null) return undefined;

			const { metadata, snapshotHtml, tabId: completedTabId } = completed;
			if (!metadata) {
				reportPhase(completedTabId, "error");
				showNotification(
					"Archive Failed",
					"Capture metadata was lost in transit.",
				);
				return undefined;
			}

			const started = captureQueue.run(metadata.url, () =>
				processCapture(metadata, snapshotHtml, completedTabId).catch((err) => {
					reportPhase(completedTabId, "error");
					showNotification("Archive Failed", String(err));
				}),
			);
			if (!started) {
				// Without this the tab keeps the non-clearing `processing` badge
				// forever: the capture that owns the terminal phase is running for
				// a different tab.
				reportPhase(completedTabId, "duplicate");
				showNotification(
					"Capture In Progress",
					`${metadata.title} is already being archived.`,
				);
			}
			return undefined;
		}

		if (message.type === CAPTURE_ABORT) {
			pendingTransfers.abort(message.captureId);
			return undefined;
		}

		if (message.type === "capture_error") {
			reportPhase(tabId, "error");
			showNotification("Capture Failed", message.error);
		}
		return undefined;
	},
);

chrome.tabs.onRemoved?.addListener((tabId) => {
	phases.delete(tabId);
	pendingTransfers.removeTab(tabId);
});

/** Inject the capture script, reporting why if the page forbids it. */
async function startCapture(tab: chrome.tabs.Tab): Promise<void> {
	if (!tab.id) return;
	reportPhase(tab.id, "capturing");
	try {
		await executeCaptureScript(tab.id);
	} catch (err) {
		reportPhase(tab.id, "error");
		showNotification("Capture Failed", describeInjectionFailure(tab.url, err));
	}
}

// Handle toolbar button click
// Note: onClicked only fires when there is NO default_popup set in the manifest.
// Our manifest has a default_popup, so this is a no-op fallback for API completeness.
const toolbarAction = chrome.action ?? legacyChrome.browserAction;
if (toolbarAction?.onClicked) {
	toolbarAction.onClicked.addListener((tab) => {
		void startCapture(tab);
	});
}

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
	if (command === "capture-page") {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs[0];
			if (tab) void startCapture(tab);
		});
	}
});
