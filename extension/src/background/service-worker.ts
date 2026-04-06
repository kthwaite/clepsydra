import TurndownService from "turndown";
import type { CaptureResult } from "#/content/capture";
import { ArchiveConflictError, ClepsydraClient } from "#/lib/api-client";
import { sha256, sha256String } from "#/lib/hasher";
import { extractDataUris } from "#/lib/resource-extractor";
import { addCasImageRule, addDemoteHeadingsRule } from "#/lib/turndown-rules";
import type {
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

interface LegacyTabsApi {
	executeScript?: (
		tabId: number,
		details: { file: string },
		callback?: () => void,
	) => void;
}

interface LegacyToolbarActionApi {
	onClicked?: {
		addListener: (callback: (tab: chrome.tabs.Tab) => void) => void;
	};
}

/** Execute content capture script in a tab across MV3 and MV2 APIs. */
function executeCaptureScript(tabId: number): void {
	if (chrome.scripting?.executeScript) {
		chrome.scripting.executeScript({
			target: { tabId },
			files: ["content/capture.js"],
		});
		return;
	}

	const legacyTabs = chrome.tabs as typeof chrome.tabs & LegacyTabsApi;
	legacyTabs.executeScript?.(tabId, { file: "content/capture.js" });
}

const IMG_SRC_REGEX = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const MAX_REMOTE_IMAGES = 50;

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

function resolveAbsoluteUrl(url: string, baseUrl: string): string | null {
	try {
		return new URL(url, baseUrl).href;
	} catch {
		return null;
	}
}

/** Build a resource map: original URI -> CAS hash. */
async function buildResourceMap(
	html: string,
	articleHtml: string | null,
	pageUrl: string,
): Promise<{ blobs: BlobUpload[]; resourceMap: Map<string, string> }> {
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
	if (articleHtml) {
		const imageSources = extractImageSources(articleHtml).slice(
			0,
			MAX_REMOTE_IMAGES,
		);

		const results = await Promise.all(
			imageSources.map(async (src) => {
				if (src.startsWith("data:")) return null;

				const absoluteSrc = resolveAbsoluteUrl(src, pageUrl);
				if (!absoluteSrc) return null;

				if (resourceMap.has(src) || resourceMap.has(absoluteSrc)) return null;

				try {
					const response = await fetch(absoluteSrc, { credentials: "include" });
					if (!response.ok) return null;

					const bytes = new Uint8Array(await response.arrayBuffer());
					const hash = await sha256(bytes);
					const contentType =
						response.headers.get("content-type")?.split(";")[0] ||
						"application/octet-stream";

					return { src, absoluteSrc, hash, contentType, bytes };
				} catch {
					return null;
				}
			}),
		);

		for (const result of results) {
			if (result) {
				resourceMap.set(result.src, result.hash);
				resourceMap.set(result.absoluteSrc, result.hash);
				blobs.push({
					hash: result.hash,
					content_type: result.contentType,
					data: uint8ToBase64(result.bytes),
				});
			}
		}
	}

	// Deduplicate by hash
	const seen = new Set<string>();
	const uniqueBlobs = blobs.filter((b) => {
		if (seen.has(b.hash)) return false;
		seen.add(b.hash);
		return true;
	});

	return { blobs: uniqueBlobs, resourceMap };
}

/** Convert article HTML to markdown with CAS image references */
function convertToMarkdown(
	articleHtml: string,
	resourceMap: Map<string, string>,
): string {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});
	addCasImageRule(td, resourceMap);
	addDemoteHeadingsRule(td);
	return td.turndown(articleHtml);
}

/** Build fallback markdown when Readability fails */
function buildFallbackMarkdown(
	url: string,
	snapshotHash: string,
	capturedAt: string,
): string {
	return [
		"> Automated reader-mode extraction failed for this page.",
		`> [View the archived HTML snapshot](cas:${snapshotHash})`,
		"",
		`**URL:** ${url}`,
		`**Captured:** ${capturedAt}`,
	].join("\n");
}

/** Main pipeline: process a capture result and send to server */
async function processCaptureResult(result: CaptureResult): Promise<void> {
	const settings = await loadSettings();
	const client = new ClepsydraClient(settings.server_url);
	const capturedAt = new Date().toISOString();
	const domain = extractDomain(result.url);

	// Hash the HTML snapshot
	const snapshotData = new TextEncoder().encode(result.singlefile_html);
	const snapshotHash = await sha256(snapshotData);

	// Extract and hash resources
	const { blobs, resourceMap } = await buildResourceMap(
		result.singlefile_html,
		result.article_html,
		result.url,
	);

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
		markdownBody = convertToMarkdown(result.article_html, resourceMap);
	} else {
		markdownBody = buildFallbackMarkdown(result.url, snapshotHash, capturedAt);
	}

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
	};

	// Send to server
	try {
		const response = await client.ingestArchive(manifest);

		if (response.status === "already_exists" && settings.notify_on_duplicate) {
			showNotification(
				"Already Archived",
				`${result.title} was already saved.`,
			);
		} else if (response.status === "created" && settings.notify_on_success) {
			showNotification(
				"Page Archived",
				`${result.title} → ${response.vault_path}`,
			);
		}
	} catch (err) {
		if (err instanceof ArchiveConflictError) {
			showNotification(
				"Content Changed",
				`${result.title} has changed since last capture.`,
			);
		} else {
			showNotification("Archive Failed", String(err));
		}
	}
}

function showNotification(title: string, message: string): void {
	chrome.notifications.create({
		type: "basic",
		iconUrl: "icons/icon-128.png",
		title,
		message,
	});
}

// Listen for capture results from content script
chrome.runtime.onMessage.addListener(
	(
		message: CaptureResult | { type: "capture_error"; error: string },
		_sender: chrome.runtime.MessageSender,
		_sendResponse: (response?: unknown) => void,
	): undefined => {
		if (message.type === "capture_result") {
			void processCaptureResult(message).catch((err) => {
				showNotification("Archive Failed", String(err));
			});
		} else if (message.type === "capture_error") {
			showNotification("Capture Failed", message.error);
		}
		return undefined;
	},
);

// Handle toolbar button click
// Note: onClicked only fires when there is NO default_popup set in the manifest.
// Our manifest has a default_popup, so this is a no-op fallback for API completeness.
const legacyChrome = chrome as typeof chrome & {
	browserAction?: LegacyToolbarActionApi;
};
const toolbarAction = chrome.action ?? legacyChrome.browserAction;
if (toolbarAction?.onClicked) {
	toolbarAction.onClicked.addListener((tab) => {
		if (tab.id) {
			executeCaptureScript(tab.id);
		}
	});
}

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
	if (command === "capture-page") {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs[0];
			if (tab?.id) {
				executeCaptureScript(tab.id);
			}
		});
	}
});
