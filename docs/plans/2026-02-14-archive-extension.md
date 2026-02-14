# Browser Extension: Web Archive Capture

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a cross-browser WebExtension that one-click captures web pages, converts them to reader-mode markdown, and sends them to the Clepsydra archive endpoint with content-hashed resources.

**Architecture:** Content script injects SingleFile + Readability into the active tab for DOM capture and content extraction. Background service worker orchestrates the pipeline: Turndown converts article HTML to markdown, Web Crypto hashes all resources, and an API client sends the structured archive manifest to `POST /api/vault/archive`. Minimal popup confirms capture status. Options page configures server URL and defaults.

**Tech Stack:** TypeScript, WebExtension API (Manifest V3 / V2 compat), SingleFile, Mozilla Readability, Turndown, Vite for bundling, Vitest for unit tests

**Design doc:** `docs/plans/2026-02-14-browser-extension-design.md`

**Prerequisite:** The server-side archive endpoint (see `docs/plans/2026-02-14-archive-server.md`) must be implemented first.

---

### Task 1: Project scaffold

**Files:**
- Create: `extension/package.json`
- Create: `extension/tsconfig.json`
- Create: `extension/vite.config.ts`
- Create: `extension/manifest.json` (Chrome Manifest V3)
- Create: `extension/manifest.v2.json` (Firefox Manifest V2)
- Create: `extension/.gitignore`

**Step 1: Initialize the project**

```bash
mkdir -p extension
cd extension
```

Create `extension/package.json`:

```json
{
  "name": "clepsydra-web-archive",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "build:firefox": "TARGET=firefox vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/"
  },
  "dependencies": {
    "@nicktomlin/turndown": "^7.2.0",
    "@anthropic-ai/readability": "npm:@nicktomlin/readability@^0.5.0"
  },
  "devDependencies": {
    "@anthropic-ai/biome": "^1.9.0",
    "@anthropic-ai/typescript": "^5.6.0",
    "@anthropic-ai/vitest": "^2.1.0",
    "@anthropic-ai/vite": "^6.0.0",
    "vite-plugin-web-extension": "^4.0.0"
  }
}
```

Note: Exact package names for readability and turndown should be verified at implementation time. The canonical packages are:
- `@mozilla/readability` (Mozilla's Readability)
- `turndown` (HTML to Markdown)
- SingleFile is vendored or loaded via `single-file-core`

**Step 2: Create manifest.json (Chrome Manifest V3)**

```json
{
  "manifest_version": 3,
  "name": "Clepsydra Web Archive",
  "version": "0.1.0",
  "description": "Capture web pages into your Clepsydra knowledge vault",
  "permissions": ["activeTab", "storage", "notifications"],
  "action": {
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    "default_popup": "popup/popup.html"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [],
  "commands": {
    "capture-page": {
      "suggested_key": {
        "default": "Ctrl+Shift+S",
        "mac": "Command+Shift+S"
      },
      "description": "Capture current page to Clepsydra"
    }
  },
  "options_page": "options/options.html",
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "paths": {
      "#/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

**Step 4: Create placeholder source files**

```
extension/src/
  background/
    service-worker.ts      # empty: export {}
  content/
    capture.ts             # empty: export {}
  lib/
    api-client.ts          # empty: export {}
    hasher.ts              # empty: export {}
    resource-extractor.ts  # empty: export {}
    turndown-rules.ts      # empty: export {}
    types.ts               # empty: export {}
  popup/
    popup.html
    popup.ts               # empty: export {}
  options/
    options.html
    options.ts             # empty: export {}
```

**Step 5: Verify the project scaffolds**

Run: `cd extension && bun install && bun run typecheck`
Expected: compiles (may have empty-file warnings, that's fine)

**Step 6: Commit**

```bash
git add extension/
git commit -m "feat(extension): scaffold browser extension project"
```

---

### Task 2: Core types and API client

**Files:**
- Create: `extension/src/lib/types.ts`
- Create: `extension/src/lib/api-client.ts`
- Create: `extension/src/lib/__tests__/api-client.test.ts`

**Step 1: Define shared types**

In `extension/src/lib/types.ts`:

```typescript
export interface ArchiveManifest {
  url: string;
  canonical_url?: string;
  domain: string;
  title: string;
  description?: string;
  captured_at: string;
  content_hash: string;
  snapshot_hash: string;
  markdown_body: string;
  tags: string[];
  blobs: BlobUpload[];
}

export interface BlobUpload {
  hash: string;
  content_type: string;
  data: string; // base64
}

export interface ArchiveResponse {
  page_id: string;
  vault_path: string;
  blobs_stored: number;
  blobs_deduped: number;
  status: "created" | "already_exists" | "content_changed";
}

export interface ArchiveStatusResponse {
  enabled: boolean;
  blob_count: number;
  total_size_bytes: number;
}

export interface ExtensionSettings {
  server_url: string;
  api_key?: string;
  default_tags: string[];
  archive_path_prefix: string;
  notify_on_success: boolean;
  notify_on_duplicate: boolean;
  on_content_changed: "update" | "new_version" | "ask";
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  server_url: "http://localhost:3000",
  default_tags: [],
  archive_path_prefix: "archive",
  notify_on_success: true,
  notify_on_duplicate: true,
  on_content_changed: "ask",
};
```

**Step 2: Write the API client with tests**

In `extension/src/lib/api-client.ts`:

```typescript
import type { ArchiveManifest, ArchiveResponse, ArchiveStatusResponse } from "./types";

export class ClepsydraClient {
  constructor(private baseUrl: string) {}

  async ingestArchive(manifest: ArchiveManifest): Promise<ArchiveResponse> {
    const res = await fetch(`${this.baseUrl}/api/vault/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });

    if (res.status === 200 || res.status === 201) {
      return res.json();
    }
    if (res.status === 409) {
      const body = await res.json();
      throw new ArchiveConflictError(body);
    }
    throw new ArchiveError(`Server returned ${res.status}: ${await res.text()}`);
  }

  async getStatus(): Promise<ArchiveStatusResponse> {
    const res = await fetch(`${this.baseUrl}/api/vault/archive/status`);
    if (!res.ok) {
      throw new ArchiveError(`Status check failed: ${res.status}`);
    }
    return res.json();
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export class ArchiveConflictError extends ArchiveError {
  constructor(public detail: unknown) {
    super("URL already archived with different content");
    this.name = "ArchiveConflictError";
  }
}
```

In `extension/src/lib/__tests__/api-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClepsydraClient, ArchiveConflictError } from "../api-client";

describe("ClepsydraClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ingestArchive returns response on 201", async () => {
    const mockResponse = {
      page_id: "abc",
      vault_path: "archive/example.com/test.md",
      blobs_stored: 1,
      blobs_deduped: 0,
      status: "created",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 201 }),
    );

    const client = new ClepsydraClient("http://localhost:3000");
    const result = await client.ingestArchive({
      url: "https://example.com",
      domain: "example.com",
      title: "Test",
      captured_at: "2026-02-14T10:00:00Z",
      content_hash: "sha256:aaa",
      snapshot_hash: "sha256:bbb",
      markdown_body: "# Test",
      tags: [],
      blobs: [],
    });

    expect(result.status).toBe("created");
    expect(result.vault_path).toContain("archive/");
  });

  it("ingestArchive returns response on 200 (duplicate)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "already_exists" }), { status: 200 }),
    );

    const client = new ClepsydraClient("http://localhost:3000");
    const result = await client.ingestArchive({
      url: "https://example.com",
      domain: "example.com",
      title: "Test",
      captured_at: "2026-02-14T10:00:00Z",
      content_hash: "sha256:aaa",
      snapshot_hash: "sha256:bbb",
      markdown_body: "# Test",
      tags: [],
      blobs: [],
    });

    expect(result.status).toBe("already_exists");
  });

  it("ingestArchive throws ArchiveConflictError on 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
    );

    const client = new ClepsydraClient("http://localhost:3000");
    await expect(
      client.ingestArchive({
        url: "https://example.com",
        domain: "example.com",
        title: "Test",
        captured_at: "2026-02-14T10:00:00Z",
        content_hash: "sha256:aaa",
        snapshot_hash: "sha256:bbb",
        markdown_body: "# Test",
        tags: [],
        blobs: [],
      }),
    ).rejects.toThrow(ArchiveConflictError);
  });

  it("isReachable returns true when server responds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true }), { status: 200 }),
    );
    const client = new ClepsydraClient("http://localhost:3000");
    expect(await client.isReachable()).toBe(true);
  });

  it("isReachable returns false when server is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
    const client = new ClepsydraClient("http://localhost:3000");
    expect(await client.isReachable()).toBe(false);
  });
});
```

**Step 3: Run tests**

Run: `cd extension && bun run test`
Expected: all PASS

**Step 4: Commit**

```bash
git add extension/src/lib/
git commit -m "feat(extension): add types, API client, and client tests"
```

---

### Task 3: Hasher module

**Files:**
- Create: `extension/src/lib/hasher.ts`
- Create: `extension/src/lib/__tests__/hasher.test.ts`

**Step 1: Write the test**

In `extension/src/lib/__tests__/hasher.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sha256, sha256String } from "../hasher";

describe("hasher", () => {
  it("sha256 hashes bytes to sha256:<hex>", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash = await sha256(data);
    // Known SHA-256 of "hello world"
    expect(hash).toBe(
      "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("sha256String hashes a string", async () => {
    const hash = await sha256String("hello world");
    expect(hash).toBe(
      "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});
```

**Step 2: Implement the hasher**

In `extension/src/lib/hasher.ts`:

```typescript
export async function sha256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export async function sha256String(text: string): Promise<string> {
  return sha256(new TextEncoder().encode(text));
}
```

**Step 3: Run tests**

Run: `cd extension && bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add extension/src/lib/hasher.ts extension/src/lib/__tests__/
git commit -m "feat(extension): add SHA-256 hasher using Web Crypto API"
```

---

### Task 4: Resource extractor

**Files:**
- Create: `extension/src/lib/resource-extractor.ts`
- Create: `extension/src/lib/__tests__/resource-extractor.test.ts`

**Step 1: Write the test**

In `extension/src/lib/__tests__/resource-extractor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractDataUris } from "../resource-extractor";

describe("extractDataUris", () => {
  it("extracts data URIs from HTML string", () => {
    const html = `
      <img src="data:image/png;base64,iVBOR..." />
      <img src="data:image/jpeg;base64,/9j/4..." />
      <link href="data:text/css;base64,Ym9keQ..." />
    `;
    const resources = extractDataUris(html);
    expect(resources).toHaveLength(3);
    expect(resources[0].content_type).toBe("image/png");
    expect(resources[0].raw_base64).toBe("iVBOR...");
    expect(resources[1].content_type).toBe("image/jpeg");
  });

  it("returns empty array for HTML with no data URIs", () => {
    const html = `<img src="https://example.com/image.png" />`;
    expect(extractDataUris(html)).toHaveLength(0);
  });

  it("deduplicates identical data URIs", () => {
    const html = `
      <img src="data:image/png;base64,AAAA" />
      <img src="data:image/png;base64,AAAA" />
    `;
    const resources = extractDataUris(html);
    expect(resources).toHaveLength(1);
  });
});
```

**Step 2: Implement the extractor**

In `extension/src/lib/resource-extractor.ts`:

```typescript
export interface ExtractedResource {
  original_uri: string;
  content_type: string;
  raw_base64: string;
}

const DATA_URI_REGEX = /data:([^;]+);base64,([A-Za-z0-9+/=.]+)/g;

export function extractDataUris(html: string): ExtractedResource[] {
  const seen = new Set<string>();
  const resources: ExtractedResource[] = [];

  for (const match of html.matchAll(DATA_URI_REGEX)) {
    const fullUri = match[0];
    if (seen.has(fullUri)) continue;
    seen.add(fullUri);

    resources.push({
      original_uri: fullUri,
      content_type: match[1],
      raw_base64: match[2],
    });
  }

  return resources;
}
```

**Step 3: Run tests**

Run: `cd extension && bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add extension/src/lib/resource-extractor.ts extension/src/lib/__tests__/
git commit -m "feat(extension): add data URI resource extractor"
```

---

### Task 5: Turndown rules for CAS image references

**Files:**
- Create: `extension/src/lib/turndown-rules.ts`
- Create: `extension/src/lib/__tests__/turndown-rules.test.ts`

**Step 1: Write the test**

In `extension/src/lib/__tests__/turndown-rules.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import TurndownService from "turndown";
import { addCasImageRule, addDemoteHeadingsRule } from "../turndown-rules";

describe("turndown CAS rules", () => {
  it("replaces img src with cas: URI when in resource map", () => {
    const td = new TurndownService();
    const resourceMap = new Map([
      ["https://example.com/photo.png", "sha256:abc123"],
    ]);
    addCasImageRule(td, resourceMap);

    const html = `<img src="https://example.com/photo.png" alt="A photo" />`;
    const md = td.turndown(html);
    expect(md).toBe("![A photo](cas:sha256:abc123)");
  });

  it("keeps original URL when not in resource map", () => {
    const td = new TurndownService();
    addCasImageRule(td, new Map());

    const html = `<img src="https://example.com/missing.png" alt="Missing" />`;
    const md = td.turndown(html);
    expect(md).toContain("https://example.com/missing.png");
    expect(md).toContain("unarchived");
  });

  it("demotes headings by one level", () => {
    const td = new TurndownService();
    addDemoteHeadingsRule(td);

    const html = `<h1>Title</h1><h2>Subtitle</h2>`;
    const md = td.turndown(html);
    expect(md).toContain("## Title");
    expect(md).toContain("### Subtitle");
  });
});
```

**Step 2: Implement the rules**

In `extension/src/lib/turndown-rules.ts`:

```typescript
import type TurndownService from "turndown";

/**
 * Replace image URLs with cas:<hash> URIs for archived resources.
 * Falls back to original URL with "unarchived" title for unknown images.
 */
export function addCasImageRule(
  td: TurndownService,
  resourceMap: Map<string, string>,
): void {
  td.addRule("cas-images", {
    filter: "img",
    replacement(_content: string, node: Node) {
      const el = node as HTMLImageElement;
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "";
      const hash = resourceMap.get(src);
      if (hash) {
        return `![${alt}](cas:${hash})`;
      }
      return `![${alt}](${src} "unarchived")`;
    },
  });
}

/**
 * Demote all headings by one level (h1 -> h2, etc.)
 * since the page title is already the top-level heading.
 */
export function addDemoteHeadingsRule(td: TurndownService): void {
  td.addRule("demote-headings", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content: string, node: Node) {
      const el = node as HTMLElement;
      const level = Number.parseInt(el.tagName[1], 10);
      const demoted = Math.min(level + 1, 6);
      const prefix = "#".repeat(demoted);
      return `\n\n${prefix} ${content.trim()}\n\n`;
    },
  });
}
```

**Step 3: Run tests**

Run: `cd extension && bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add extension/src/lib/turndown-rules.ts extension/src/lib/__tests__/
git commit -m "feat(extension): add Turndown CAS image and heading demotion rules"
```

---

### Task 6: Content script — capture.ts

**Files:**
- Create: `extension/src/content/capture.ts`

This script is injected into the active tab. It runs SingleFile and Readability, then messages the results back to the background worker. This is hard to unit test (requires a real DOM), so we rely on the integration being tested via manual testing and the unit-tested lib modules.

**Step 1: Implement the content script**

In `extension/src/content/capture.ts`:

```typescript
/**
 * Content script injected into the active tab.
 * Runs SingleFile for faithful HTML capture and Readability for content extraction.
 * Results are messaged back to the background service worker.
 */

import { Readability } from "@mozilla/readability";

export interface CaptureResult {
  type: "capture_result";
  url: string;
  canonical_url?: string;
  title: string;
  description?: string;
  singlefile_html: string;
  article_html: string | null;
  article_text_length: number;
}

async function capture(): Promise<CaptureResult> {
  const url = window.location.href;
  const canonical =
    document.querySelector<HTMLLinkElement>("link[rel=canonical]")?.href;
  const title = document.title;
  const description =
    document.querySelector<HTMLMetaElement>("meta[name=description]")?.content;

  // Run SingleFile to get faithful HTML snapshot
  // SingleFile is expected to be injected or loaded as a library
  // For now, use a simplified DOM serialization as a placeholder
  // TODO: integrate single-file-core library
  const singlefile_html = document.documentElement.outerHTML;

  // Run Readability on a cloned document (it mutates the DOM)
  const clonedDoc = document.cloneNode(true) as Document;
  const article = new Readability(clonedDoc).parse();

  return {
    type: "capture_result",
    url,
    canonical_url: canonical || undefined,
    title,
    description: description || undefined,
    singlefile_html,
    article_html: article?.content || null,
    article_text_length: article?.textContent?.length || 0,
  };
}

// Execute capture and send result to background
capture().then((result) => {
  chrome.runtime.sendMessage(result);
}).catch((err) => {
  chrome.runtime.sendMessage({
    type: "capture_error",
    error: String(err),
  });
});
```

Note: SingleFile integration is marked as TODO. The `single-file-core` package needs to be evaluated for bundling compatibility. For the initial implementation, `document.documentElement.outerHTML` provides a basic HTML snapshot. SingleFile can be integrated as a follow-up task when the core pipeline works end-to-end.

**Step 2: Verify it typechecks**

Run: `cd extension && bun run typecheck`
Expected: compiles (may need `@types/chrome` in devDependencies)

Add `@anthropic-ai/types-chrome: "npm:@anthropic-ai/types-chrome@latest"` or the canonical `@anthropic-ai/chrome-types` package if needed. The exact package name should be verified at implementation time — the standard package is `@anthropic-ai/chrome-types` or simply `chrome-types`.

**Step 3: Commit**

```bash
git add extension/src/content/
git commit -m "feat(extension): add content script with Readability capture"
```

---

### Task 7: Background service worker — pipeline orchestrator

**Files:**
- Create: `extension/src/background/service-worker.ts`

**Step 1: Implement the service worker**

In `extension/src/background/service-worker.ts`:

```typescript
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

/** Build a resource map from SingleFile HTML: original URL -> CAS hash */
async function buildResourceMap(
  html: string,
): Promise<{ blobs: BlobUpload[]; resourceMap: Map<string, string> }> {
  const extracted = extractDataUris(html);
  const blobs: BlobUpload[] = [];
  const resourceMap = new Map<string, string>();

  for (const resource of extracted) {
    // Decode base64 to compute hash
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
  const { blobs, resourceMap } = await buildResourceMap(
    result.singlefile_html,
  );

  // Add snapshot itself as a blob
  const snapshotBlob: BlobUpload = {
    hash: snapshotHash,
    content_type: "text/html",
    data: btoa(
      String.fromCharCode(...new TextEncoder().encode(result.singlefile_html)),
    ),
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
      showNotification("Already Archived", `${result.title} was already saved.`);
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
  (message: CaptureResult | { type: "capture_error"; error: string }) => {
    if (message.type === "capture_result") {
      processCaptureResult(message);
    } else if (message.type === "capture_error") {
      showNotification("Capture Failed", message.error);
    }
  },
);

// Handle toolbar button click
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
```

**Step 2: Verify it typechecks**

Run: `cd extension && bun run typecheck`
Expected: compiles

**Step 3: Commit**

```bash
git add extension/src/background/
git commit -m "feat(extension): add background service worker pipeline"
```

---

### Task 8: Popup and options UI

**Files:**
- Create: `extension/src/popup/popup.html`
- Create: `extension/src/popup/popup.ts`
- Create: `extension/src/options/options.html`
- Create: `extension/src/options/options.ts`

**Step 1: Implement the popup**

The popup is minimal — shows status and a capture button.

In `extension/src/popup/popup.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { width: 280px; padding: 12px; font-family: system-ui, sans-serif; font-size: 13px; }
    .status { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.connected { background: #22c55e; }
    .dot.disconnected { background: #ef4444; }
    button { width: 100%; padding: 8px; border: 2px solid #000; background: #fff;
             font-size: 13px; cursor: pointer; }
    button:hover { background: #f0f0f0; }
    .footer { margin-top: 12px; font-size: 11px; color: #666; }
    a { color: #666; }
  </style>
</head>
<body>
  <div class="status">
    <div class="dot" id="status-dot"></div>
    <span id="status-text">Checking...</span>
  </div>
  <button id="capture-btn">Capture This Page</button>
  <div class="footer">
    <a href="#" id="options-link">Settings</a>
  </div>
  <script src="popup.js" type="module"></script>
</body>
</html>
```

In `extension/src/popup/popup.ts`:

```typescript
import { ClepsydraClient } from "#/lib/api-client";
import { DEFAULT_SETTINGS } from "#/lib/types";

async function init() {
  const stored = await chrome.storage.sync.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  const client = new ClepsydraClient(settings.server_url);

  const dot = document.getElementById("status-dot")!;
  const text = document.getElementById("status-text")!;

  const reachable = await client.isReachable();
  dot.classList.add(reachable ? "connected" : "disconnected");
  text.textContent = reachable ? `Connected to ${settings.server_url}` : "Server unreachable";

  document.getElementById("capture-btn")!.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/capture.js"],
        });
        window.close();
      }
    });
  });

  document.getElementById("options-link")!.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

init();
```

**Step 2: Implement the options page**

In `extension/src/options/options.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { max-width: 480px; margin: 40px auto; padding: 0 16px;
           font-family: system-ui, sans-serif; font-size: 14px; }
    h1 { font-size: 18px; margin-bottom: 24px; }
    label { display: block; margin-top: 16px; font-weight: 600; }
    input[type="text"] { width: 100%; padding: 8px; border: 2px solid #000;
                          margin-top: 4px; font-size: 14px; box-sizing: border-box; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    select { padding: 8px; border: 2px solid #000; margin-top: 4px; font-size: 14px; }
    button { margin-top: 24px; padding: 10px 20px; border: 2px solid #000;
             background: #000; color: #fff; font-size: 14px; cursor: pointer; }
    button:hover { background: #333; }
    .saved { color: #22c55e; margin-left: 12px; display: none; }
    .status { margin-top: 16px; padding: 8px; border: 2px solid #000; }
  </style>
</head>
<body>
  <h1>Clepsydra Web Archive</h1>

  <label for="server-url">Server URL</label>
  <input type="text" id="server-url" placeholder="http://localhost:3000" />

  <label for="default-tags">Default Tags (comma-separated)</label>
  <input type="text" id="default-tags" placeholder="reading, research" />

  <div class="checkbox-row">
    <input type="checkbox" id="notify-success" />
    <label for="notify-success" style="margin-top:0;font-weight:normal">
      Notify on successful capture
    </label>
  </div>

  <div class="checkbox-row">
    <input type="checkbox" id="notify-duplicate" />
    <label for="notify-duplicate" style="margin-top:0;font-weight:normal">
      Notify when page already archived
    </label>
  </div>

  <label for="on-changed">When content has changed</label>
  <select id="on-changed">
    <option value="ask">Ask me</option>
    <option value="update">Update existing page</option>
    <option value="new_version">Create new version</option>
  </select>

  <div>
    <button id="save-btn">Save</button>
    <span class="saved" id="saved-msg">Saved</span>
  </div>

  <div class="status" id="status-box"></div>

  <script src="options.js" type="module"></script>
</body>
</html>
```

In `extension/src/options/options.ts`:

```typescript
import { ClepsydraClient } from "#/lib/api-client";
import type { ExtensionSettings } from "#/lib/types";
import { DEFAULT_SETTINGS } from "#/lib/types";

async function init() {
  const stored = await chrome.storage.sync.get("settings");
  const settings: ExtensionSettings = { ...DEFAULT_SETTINGS, ...stored.settings };

  // Populate form
  (document.getElementById("server-url") as HTMLInputElement).value = settings.server_url;
  (document.getElementById("default-tags") as HTMLInputElement).value = settings.default_tags.join(", ");
  (document.getElementById("notify-success") as HTMLInputElement).checked = settings.notify_on_success;
  (document.getElementById("notify-duplicate") as HTMLInputElement).checked = settings.notify_on_duplicate;
  (document.getElementById("on-changed") as HTMLSelectElement).value = settings.on_content_changed;

  // Save handler
  document.getElementById("save-btn")!.addEventListener("click", async () => {
    const newSettings: ExtensionSettings = {
      server_url: (document.getElementById("server-url") as HTMLInputElement).value.replace(/\/$/, ""),
      default_tags: (document.getElementById("default-tags") as HTMLInputElement).value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      archive_path_prefix: "archive",
      notify_on_success: (document.getElementById("notify-success") as HTMLInputElement).checked,
      notify_on_duplicate: (document.getElementById("notify-duplicate") as HTMLInputElement).checked,
      on_content_changed: (document.getElementById("on-changed") as HTMLSelectElement).value as ExtensionSettings["on_content_changed"],
    };

    await chrome.storage.sync.set({ settings: newSettings });

    const savedMsg = document.getElementById("saved-msg")!;
    savedMsg.style.display = "inline";
    setTimeout(() => { savedMsg.style.display = "none"; }, 2000);

    // Check connection
    checkStatus(newSettings.server_url);
  });

  checkStatus(settings.server_url);
}

async function checkStatus(serverUrl: string) {
  const statusBox = document.getElementById("status-box")!;
  const client = new ClepsydraClient(serverUrl);
  try {
    const status = await client.getStatus();
    statusBox.textContent = `Connected — ${status.blob_count} blobs, ${(status.total_size_bytes / 1024 / 1024).toFixed(1)} MB`;
    statusBox.style.borderColor = "#22c55e";
  } catch {
    statusBox.textContent = "Server unreachable";
    statusBox.style.borderColor = "#ef4444";
  }
}

init();
```

**Step 3: Verify it typechecks**

Run: `cd extension && bun run typecheck`
Expected: compiles

**Step 4: Commit**

```bash
git add extension/src/popup/ extension/src/options/
git commit -m "feat(extension): add popup and options UI"
```

---

### Task 9: Build configuration and cross-browser support

**Files:**
- Create: `extension/vite.config.ts`
- Create: `extension/manifest.v2.json` (Firefox)

**Step 1: Configure Vite for extension bundling**

In `extension/vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest:
        process.env.TARGET === "firefox"
          ? "manifest.v2.json"
          : "manifest.json",
    }),
  ],
  build: {
    outDir: process.env.TARGET === "firefox" ? "dist-firefox" : "dist",
  },
});
```

Note: The `vite-plugin-web-extension` package handles entry point resolution from the manifest. Verify the plugin's actual API at implementation time — the config above is illustrative. An alternative is `@anthropic-ai/vite-plugin-browser-extension` or manual Vite `build.rollupOptions.input` configuration.

**Step 2: Create Firefox Manifest V2**

In `extension/manifest.v2.json`:

```json
{
  "manifest_version": 2,
  "name": "Clepsydra Web Archive",
  "version": "0.1.0",
  "description": "Capture web pages into your Clepsydra knowledge vault",
  "permissions": ["activeTab", "storage", "notifications"],
  "browser_action": {
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png"
    },
    "default_popup": "popup/popup.html"
  },
  "background": {
    "scripts": ["background/service-worker.js"],
    "persistent": false
  },
  "commands": {
    "capture-page": {
      "suggested_key": {
        "default": "Ctrl+Shift+S",
        "mac": "Command+Shift+S"
      },
      "description": "Capture current page to Clepsydra"
    }
  },
  "options_ui": {
    "page": "options/options.html",
    "open_in_tab": true
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

**Step 3: Verify builds**

Run: `cd extension && bun run build`
Expected: produces `dist/` directory with bundled extension

Run: `cd extension && TARGET=firefox bun run build`
Expected: produces `dist-firefox/` directory

**Step 4: Commit**

```bash
git add extension/vite.config.ts extension/manifest.v2.json
git commit -m "feat(extension): add Vite build config and Firefox manifest"
```

---

### Task 10: Final polish — typecheck, lint, test suite

**Files:**
- Various (lint fixes)

**Step 1: Run full test suite**

Run: `cd extension && bun run test`
Expected: all tests pass

**Step 2: Typecheck**

Run: `cd extension && bun run typecheck`
Expected: clean

**Step 3: Build both targets**

Run: `cd extension && bun run build && TARGET=firefox bun run build`
Expected: both builds succeed

**Step 4: Commit any fixes**

```bash
git add extension/
git commit -m "chore(extension): lint, typecheck, and build polish"
```
