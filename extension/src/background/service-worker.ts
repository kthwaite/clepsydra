import TurndownService from "turndown";
import { ClepsydraClient, ArchiveConflictError } from "#/lib/api-client";
import { sha256, sha256String } from "#/lib/hasher";
import { extractDataUris } from "#/lib/resource-extractor";
import { addCasImageRule, addDemoteHeadingsRule } from "#/lib/turndown-rules";
import type {
  ArchiveManifest,
  BlobUpload,
  ExtensionSettings,
} from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";
import type { CaptureResult } from "#/content/capture";

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

/** Encode a Uint8Array to base64 without spread operator (safe for large data) */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Build a resource map from SingleFile HTML: original URI -> CAS hash */
async function buildResourceMap(
  html: string,
): Promise<{ blobs: BlobUpload[]; resourceMap: Map<string, string> }> {
  const extracted = extractDataUris(html);
  const blobs: BlobUpload[] = [];
  const resourceMap = new Map<string, string>();

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
  const { blobs, resourceMap } = await buildResourceMap(result.singlefile_html);

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
  const tags = [
    "archive",
    domain,
    currentMonthTag(),
    ...settings.default_tags,
  ];

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
      processCaptureResult(message as CaptureResult);
    } else if (message.type === "capture_error") {
      showNotification("Capture Failed", message.error);
    }
    return undefined;
  },
);

// Handle toolbar button click
// Note: onClicked only fires when there is NO default_popup set in the manifest.
// Our manifest has a default_popup, so this is a no-op fallback for API completeness.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/capture.js"],
    });
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-page") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/capture.js"],
        });
      }
    });
  }
});
