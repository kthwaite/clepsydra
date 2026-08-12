import type { CaptureResult } from "#/content/capture";
import { ArchiveConflictError, ClepsydraClient } from "#/lib/api-client";
import { type CapturePhase, badgeFor, isTerminal } from "#/lib/badge";
import { CaptureQueue } from "#/lib/capture-queue";
import { sha256, sha256String } from "#/lib/hasher";
import { executeCaptureScript } from "#/lib/inject-capture";
import { describeInjectionFailure } from "#/lib/injection";
import { fetchRemoteImages } from "#/lib/remote-resources";
import { extractDataUris } from "#/lib/resource-extractor";
import { convertArchiveHtml } from "#/lib/turndown-rules";
import type {
	ArchiveConflictDetail,
	ArchiveManifest,
	BlobUpload,
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

/** Encode a Uint8Array to base64 with chunking to avoid stack limits. */
function uint8ToBase64(bytes: Uint8Array): string {
	const CHUNK_SIZE = 0x8000; // 32KB
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		const end = Math.min(i + CHUNK_SIZE, bytes.length);
		let chunk = "";
		for (let j = i; j < end; j++) {
			chunk += String.fromCharCode(bytes[j]);
		}
		parts.push(chunk);
	}
	return btoa(parts.join(""));
}

interface LegacyToolbarActionApi {
	onClicked?: {
		addListener: (callback: (tab: chrome.tabs.Tab) => void) => void;
	};
}

const IMG_SRC_REGEX = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const MAX_REMOTE_IMAGES = 50;
/** Bound on a single resource fetch, so one hung CDN cannot stall a capture. */
const RESOURCE_TIMEOUT_MS = 15_000;

function extractImageSources(articleHtml: string): string[] {
	const sources = new Set<string>();
	for (const match of articleHtml.matchAll(IMG_SRC_REGEX)) {
		const src = match[1]?.trim();
		if (src) {
			sources.add(src);
		}
	}
	return [...sources];
}

interface ResourceBundle {
	blobs: BlobUpload[];
	resourceMap: Map<string, string>;
	/** Images that were found but not archived, for any reason. */
	skipped: number;
}

/** Build a resource map: original URI -> CAS hash. */
async function buildResourceMap(
	html: string,
	articleHtml: string | null,
	pageUrl: string,
	settings: ExtensionSettings,
): Promise<ResourceBundle> {
	const extracted = extractDataUris(html);
	const blobs: BlobUpload[] = [];
	const resourceMap = new Map<string, string>();

	// 1) Inline resources already embedded as data: URIs.
	for (const resource of extracted) {
		const binary = Uint8Array.from(atob(resource.raw_base64), (c) =>
			c.charCodeAt(0),
		);
		const hash = await sha256(binary);

		resourceMap.set(resource.original_uri, hash);
		blobs.push({
			hash,
			content_type: resource.content_type,
			data: resource.raw_base64,
		});
	}

	// 2) Reader-mode image URLs in article HTML.
	let skipped = 0;
	if (articleHtml) {
		const { resources, skipped: dropped } = await fetchRemoteImages(
			extractImageSources(articleHtml),
			{
				pageUrl,
				maxImages: MAX_REMOTE_IMAGES,
				perResourceTimeoutMs: RESOURCE_TIMEOUT_MS,
				maxBlobBytes: settings.max_blob_size_mb * 1024 * 1024,
				totalBudgetBytes: settings.max_request_size_mb * 1024 * 1024,
				hash: sha256,
				alreadyArchived: (src) => resourceMap.has(src),
			},
		);
		skipped = dropped;

		for (const resource of resources) {
			resourceMap.set(resource.src, resource.hash);
			resourceMap.set(resource.absoluteSrc, resource.hash);
			blobs.push({
				hash: resource.hash,
				content_type: resource.contentType,
				data: uint8ToBase64(resource.bytes),
			});
		}
	}

	// Deduplicate by hash
	const seen = new Set<string>();
	const uniqueBlobs = blobs.filter((b) => {
		if (seen.has(b.hash)) return false;
		seen.add(b.hash);
		return true;
	});

	return { blobs: uniqueBlobs, resourceMap, skipped };
}

/** Build fallback markdown when Readability fails */
function buildFallbackMarkdown(
	url: string,
	snapshotHash: string,
	capturedAt: string,
): string {
	return [
		"> Automated reader-mode extraction failed for this page.",
		`> [Download the archived HTML snapshot](cas:${snapshotHash})`,
		"",
		`**URL:** ${url}`,
		`**Captured:** ${capturedAt}`,
	].join("\n");
}

/**
 * Record that the archive is incomplete. A partial capture that looks complete
 * is worse than one that admits what it is missing.
 */
function appendIncompleteNote(markdown: string, skipped: number): string {
	if (skipped <= 0) return markdown;
	const plural = skipped === 1 ? "resource" : "resources";
	return `${markdown}\n\n> ${skipped} ${plural} could not be archived (too large, unreachable, or beyond the per-capture limit).`;
}

/** Main pipeline: process a capture result and send to server */
async function processCaptureResult(
	result: CaptureResult,
	tabId: number | undefined,
): Promise<void> {
	const settings = await loadSettings();
	const client = new ClepsydraClient(settings.server_url);
	const capturedAt = new Date().toISOString();
	const domain = extractDomain(result.url);

	// Hash the HTML snapshot
	const snapshotData = new TextEncoder().encode(result.singlefile_html);
	const snapshotHash = await sha256(snapshotData);

	// Extract and hash resources
	const { blobs, resourceMap, skipped } = await buildResourceMap(
		result.singlefile_html,
		result.article_html,
		result.url,
		settings,
	);

	reportPhase(tabId, "uploading");

	// Add snapshot itself as a blob
	const snapshotBlob: BlobUpload = {
		hash: snapshotHash,
		content_type: "text/html",
		data: uint8ToBase64(new TextEncoder().encode(result.singlefile_html)),
	};
	const allBlobs = [snapshotBlob, ...blobs];

	// Convert to markdown
	let markdownBody: string;
	if (result.article_html && result.article_text_length >= 200) {
		markdownBody = convertArchiveHtml(result.article_html, resourceMap);
	} else {
		markdownBody = buildFallbackMarkdown(result.url, snapshotHash, capturedAt);
	}
	markdownBody = appendIncompleteNote(markdownBody, skipped);

	const contentHash = await sha256String(markdownBody);

	// Build auto-tags
	const tags = ["archive", domain, currentMonthTag(), ...settings.default_tags];

	// Build manifest
	const manifest: ArchiveManifest = {
		url: result.url,
		canonical_url: result.canonical_url,
		domain,
		title: result.title,
		description: result.description,
		captured_at: capturedAt,
		content_hash: contentHash,
		snapshot_hash: snapshotHash,
		markdown_body: markdownBody,
		tags,
		blobs: allBlobs,
		byline: result.byline,
		site_name: result.site_name,
		published_time: result.published_time,
		lang: result.lang,
		excerpt: result.excerpt,
	};

	// Send to server
	try {
		const response = await client.ingestArchive(manifest);

		if (response.status === "already_exists") {
			reportPhase(tabId, "duplicate");
			if (settings.notify_on_duplicate) {
				showNotification(
					"Already Archived",
					`${result.title} was already saved.`,
				);
			}
		} else {
			reportPhase(tabId, "done");
			if (settings.notify_on_success) {
				showNotification(
					"Page Archived",
					`${result.title} → ${response.vault_path}`,
				);
			}
		}
	} catch (err) {
		if (err instanceof ArchiveConflictError) {
			reportPhase(tabId, "conflict");
			showNotification("Content Changed", describeConflict(result.title, err));
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

chrome.tabs.onRemoved?.addListener((tabId) => phases.delete(tabId));

/**
 * Guards every capture: suppresses duplicates for a URL already being captured,
 * and keeps the service worker alive while asynchronous work is outstanding.
 */
const captureQueue = new CaptureQueue({
	keepAlive: () => {
		// Any extension API call resets the service worker's idle timer. The
		// result is irrelevant; only the call matters.
		try {
			void Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => {});
		} catch {
			// MV2 background pages are not suspended, so a failure here is benign.
		}
	},
});

type WorkerMessage =
	| CaptureResult
	| { type: "capture_error"; error: string }
	| { type: "capture_status"; tabId: number };

// Listen for capture results from content script, and status queries from the popup
chrome.runtime.onMessage.addListener(
	(
		message: WorkerMessage,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	): undefined => {
		if (message.type === "capture_status") {
			// Answered synchronously, so no need to hold the channel open.
			sendResponse({ phase: phases.get(message.tabId) ?? null });
			return undefined;
		}

		const tabId = sender.tab?.id;

		if (message.type === "capture_result") {
			reportPhase(tabId, "processing");
			const started = captureQueue.run(message.url, () =>
				processCaptureResult(message, tabId).catch((err) => {
					reportPhase(tabId, "error");
					showNotification("Archive Failed", String(err));
				}),
			);
			if (!started) {
				showNotification(
					"Capture In Progress",
					`${message.title} is already being archived.`,
				);
			}
		} else if (message.type === "capture_error") {
			reportPhase(tabId, "error");
			showNotification("Capture Failed", message.error);
		}
		return undefined;
	},
);

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
