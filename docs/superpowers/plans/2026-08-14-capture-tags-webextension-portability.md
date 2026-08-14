# Capture Tags and WebExtension Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable-default plus per-capture tags to the extension, permit metadata-only tag editing on archived Folios, and remove production dependence on a `chrome` global.

**Architecture:** A thin `webext` module selects native `browser` before `chrome`; existing API-specific helpers continue to normalize MV2/MV3 differences. Capture additions live on the persisted attempt status and are carried into the archive manifest by the worker. Archived Folios reuse `TagInput` and `usePageEditor` metadata-only saves while retaining body protection.

**Tech Stack:** TypeScript, Vite WebExtension plugin, Vitest, WebExtension MV3/MV2 APIs, React 19, React Aria Components, TanStack Query/Router, Slate, Rust/Axum archive and page APIs.

**Spec:** `docs/superpowers/specs/2026-08-14-capture-tags-webextension-portability-design.md`

## Global Constraints

- Prefer `globalThis.browser`; fall back to `globalThis.chrome`; never mutate either global.
- Do not add `webextension-polyfill`: its bootstrap requires `globalThis.chrome.runtime.id` even on a browser-only host.
- Runtime production code must not directly read `chrome` or `browser`; type-only `chrome` namespace references are permitted because they are erased.
- Chromium MV3 and Firefox MV2 remain the only packaged and verified targets; do not claim Safari support.
- Popup additions affect one capture and never write `storage.sync`; configured defaults remain immutable in the popup.
- Capture tag order is system tags, configured defaults, then additions; trim, strip one leading `#`, drop empty strings, exact-deduplicate, preserve case and first occurrence.
- Toolbar and keyboard captures have no per-capture additions.
- Archive title, aliases, body, provenance, snapshot, hashes, and CAS resources remain protected; only ordinary tags become editable. Computed tags remain immutable.
- Every implementation task is RED→GREEN, committed separately, and reviewed before the next dependent task.

---

### Task 1: WebExtension API Boundary and Clean Cutover

**Files:**
- Create: `extension/src/lib/webext.ts`
- Create: `extension/src/lib/__tests__/webext.test.ts`
- Modify: `extension/src/background/service-worker.ts`
- Modify: `extension/src/content/capture.ts`
- Modify: `extension/src/lib/inject-capture.ts`
- Modify: `extension/src/lib/relay-fetch.ts`
- Modify: `extension/src/options/options.ts`
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/scripts/verify-bundle.mjs`
- Test: `extension/src/background/service-worker.test.ts`
- Test: `extension/src/lib/__tests__/inject-capture.test.ts`
- Test: `extension/src/lib/__tests__/relay-fetch.test.ts`
- Test: `extension/src/popup/popup.test.ts`

**Interfaces:**
- Produces: `resolveWebExtensionApi(root?: WebExtensionRoot): typeof chrome`
- Produces: `webext: typeof chrome`, resolved once from `globalThis`
- Consumes later: every production WebExtension value access imports `webext` from `#/lib/webext`
- Invariant: `browser` wins when both namespaces exist; absence of `runtime` on both throws `WebExtension API unavailable: neither browser.runtime nor chrome.runtime exists.`

- [ ] **Step 1: Add RED namespace-resolution tests**

Create `extension/src/lib/__tests__/webext.test.ts` with module-reset tests that install complete minimal runtime objects before dynamically importing the module:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = { id: "clepsydra-test" };

async function loadWith(root: { browser?: unknown; chrome?: unknown }) {
  vi.resetModules();
  vi.stubGlobal("browser", root.browser);
  vi.stubGlobal("chrome", root.chrome);
  return import("#/lib/webext");
}

afterEach(() => vi.unstubAllGlobals());

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
```

- [ ] **Step 2: Run the resolver test and prove RED**

Run: `bun run test src/lib/__tests__/webext.test.ts`

Expected: FAIL because `#/lib/webext` does not exist.

- [ ] **Step 3: Implement the minimal selector**

Create `extension/src/lib/webext.ts`:

```ts
type WebExtensionApi = typeof chrome;

type WebExtensionRoot = {
  browser?: WebExtensionApi;
  chrome?: WebExtensionApi;
};

export function resolveWebExtensionApi(
  root: WebExtensionRoot = globalThis as WebExtensionRoot,
): WebExtensionApi {
  const api = root.browser?.runtime ? root.browser : root.chrome;
  if (!api?.runtime) {
    throw new Error(
      "WebExtension API unavailable: neither browser.runtime nor chrome.runtime exists.",
    );
  }
  return api;
}

export const webext = resolveWebExtensionApi();
```

Run: `bun run test src/lib/__tests__/webext.test.ts`

Expected: 3 tests PASS.

- [ ] **Step 4: Add RED browser-only production-module tests**

Extend existing dynamic-import harnesses so at least the service worker, popup, injection helper, relay helper, content capture, and options entry load or execute with `browser` installed and `chrome` absent. Add a bundle verifier case whose sandbox has only `browser` and assert the worker registers exactly the existing five listeners.

In `verify-bundle.mjs`, represent the two cases explicitly:

```js
const namespaceCases = [
  { name: "chrome-only", install: (api) => ({ chrome: api }) },
  { name: "browser-only", install: (api) => ({ browser: api }) },
];
```

Run the focused tests and verifier against the current sources/bundle.

Expected: browser-only cases fail with direct `chrome` reads.

- [ ] **Step 5: Migrate every production value access to `webext`**

Add `import { webext } from "#/lib/webext";` to each production module and replace value expressions only:

```ts
const stored = await webext.storage.sync.get("settings");
await webext.runtime.sendMessage(message);
const tab = await webext.tabs.get(tabId);
webext.runtime.onMessage.addListener(listener);
```

Preserve type positions such as `chrome.tabs.Tab` unless changing them is necessary for compilation. Rename value aliases such as `legacyChrome` to `legacyWebext`. Keep the existing MV3/MV2 script-injection helper; source its `runtime`, `scripting`, and `tabs` values from `webext`. Convert popup active-tab lookup to the shared Promise contract:

```ts
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await webext.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}
```

For callback-era MV2 `tabs.executeScript`, preserve explicit `runtime.lastError` handling and support either a returned Promise or callback completion; do not assume `browser.tabs.executeScript` accepts a Chrome-only callback.

- [ ] **Step 6: Prove no direct production global reads remain**

Run repository search over `extension/src` excluding tests and `webext.ts` for `\bchrome\.` and `\bbrowser\.`. Inspect each match: only erased type references, comments, restricted-host strings, and the selector module are allowed. Any emitted value access must import `webext`.

- [ ] **Step 7: Run Task 1 focused verification**

Run:

```bash
bun run test src/lib/__tests__/webext.test.ts src/lib/__tests__/inject-capture.test.ts src/lib/__tests__/relay-fetch.test.ts src/background/service-worker.test.ts src/popup/popup.test.ts
bun run typecheck
bun run build
bun run build:firefox
```

Expected: all focused tests PASS; typecheck PASS; both bundle verifiers report five listeners for chrome-only and browser-only harnesses.

- [ ] **Step 8: Commit Task 1**

```bash
git add extension/src extension/scripts/verify-bundle.mjs
git commit -m "refactor(extension): centralize webextension API access"
```

---

### Task 2: Capture Tag Contract, Normalization, and Attempt Persistence

**Files:**
- Create: `extension/src/lib/capture-tags.ts`
- Create: `extension/src/lib/__tests__/capture-tags.test.ts`
- Modify: `extension/src/lib/badge.ts`
- Modify: `extension/src/background/service-worker.ts`
- Modify: `extension/src/background/service-worker.test.ts`

**Interfaces:**
- Produces: `normalizeCaptureTags(value: unknown): string[]`
- Produces: `mergeCaptureTags(...groups: readonly (readonly unknown[])[]): string[]`
- Changes: `CaptureStatus` gains required `additionalTags: string[]`
- Changes: `capture_start` accepts `additionalTags?: unknown`; the worker normalizes it before claiming
- Invariant: a bound `CaptureAttempt` owns an immutable copy of additions; later starts/status changes cannot replace it

- [ ] **Step 1: Write RED normalization tests**

Create tests asserting exact output:

```ts
expect(normalizeCaptureTags(["  #research ", "", 7, "Research", "research"]))
  .toEqual(["research", "Research"]);

expect(
  mergeCaptureTags(
    ["archive", "example.com", "2026-08"],
    ["archive", "default"],
    ["#default", "reading"],
  ),
).toEqual(["archive", "example.com", "2026-08", "default", "reading"]);
```

Also assert non-array input returns `[]`, one leading `#` is removed, `##tag` retains one `#`, and case-distinct strings remain distinct.

Run: `bun run test src/lib/__tests__/capture-tags.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement allocation-conscious normalization**

Implement one ordered loop and `Set<string>`; do not flatten or repeatedly filter arrays:

```ts
function appendNormalized(
  output: string[],
  seen: Set<string>,
  values: readonly unknown[],
): void {
  for (const value of values) {
    if (typeof value !== "string") continue;
    let tag = value.trim();
    if (tag.startsWith("#")) tag = tag.slice(1).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
}
```

`normalizeCaptureTags` accepts only arrays; `mergeCaptureTags` appends each supplied group in order.

Run the focused file; expected all tests PASS.

- [ ] **Step 3: Add RED worker attempt tests**

Extend the worker harness and tests to prove:

1. `capture_start` normalizes additions and returns them in status.
2. A second start while active cannot replace additions.
3. session rehydration retains valid additions and maps missing/malformed legacy values to `[]`.
4. a worker restart after start but before `capture_meta` still sends additions in the archive manifest.
5. toolbar and command listeners produce `additionalTags: []`.
6. manifest tags are system → defaults → additions with exact deduplication.

Use explicit requests:

```ts
await worker.dispatch({
  type: "capture_start",
  tabId: 7,
  additionalTags: [" #reading ", "archive", "reading"],
});
```

Expected before implementation: status lacks additions and manifest lacks `reading`.

- [ ] **Step 4: Persist additions with status and binding**

Update `CaptureStatus` and guards:

```ts
export interface CaptureStatus {
  phase: CapturePhase;
  detail: string;
  attemptId: string;
  startedAt: number;
  updatedAt: number;
  additionalTags: string[];
}
```

`isCaptureStatus` accepts legacy missing data and produces normalized data during rehydration rather than trusting the stored array. Change attempt claiming to accept normalized additions only when `started === true`. Extend `CaptureAttempt` with `additionalTags: string[]`; copy the current status additions when binding `captureId`.

Change `processCapture` to accept additions and build:

```ts
tags: mergeCaptureTags(
  ["archive", domain, currentMonthTag()],
  settings.default_tags,
  additionalTags,
),
```

All status constructors, repairs, and test fixtures must provide or derive `additionalTags`. Toolbar/command paths call claim/start with `[]`.

- [ ] **Step 5: Run Task 2 focused verification**

Run:

```bash
bun run test src/lib/__tests__/capture-tags.test.ts src/lib/__tests__/badge.test.ts src/background/service-worker.test.ts
bun run typecheck
```

Expected: all focused tests and typecheck PASS; notification-isolation tests remain green.

- [ ] **Step 6: Commit Task 2**

```bash
git add extension/src/lib/capture-tags.ts extension/src/lib/__tests__/capture-tags.test.ts extension/src/lib/badge.ts extension/src/background/service-worker.ts extension/src/background/service-worker.test.ts
git commit -m "feat(extension): persist per-capture tags"
```

---

### Task 3: Popup Default and Additional Tag Controls

**Files:**
- Modify: `extension/src/popup/popup.html`
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/src/popup/popup.test.ts`

**Interfaces:**
- Consumes: `normalizeCaptureTags(value: unknown): string[]`
- Consumes: `CaptureStatus.additionalTags: string[]`
- Changes: `requestCaptureStart(tabId: number, additionalTags: string[]): Promise<CaptureStatus>`
- UI contract: `#default-tags` is immutable; `#additional-tags` is labelled, per-capture, and disabled only for active capture/start

- [ ] **Step 1: Add RED semantic-markup tests**

Render the real popup HTML in the harness and assert:

```ts
expect(screen.getByText("Defaults")).toBeInTheDocument();
expect(screen.getByRole("textbox", { name: "Additional tags" })).toBeEnabled();
expect(screen.getByText(/only this capture/i)).toBeInTheDocument();
```

Load settings with `default_tags: ["archive", "research"]` and assert both are visible outside the textbox. Assert there is no control that removes defaults.

Run: `bun run test src/popup/popup.test.ts`

Expected: FAIL because controls do not exist.

- [ ] **Step 2: Add RED capture-message and lifecycle tests**

Cover these observable cases:

- type `" #reading, research, reading "`, click Capture, and expect `capture_start.additionalTags` exactly `['reading', 'research']`;
- assert `chrome.storage.sync.set`/native equivalent is never called;
- active restored status fills the additions input and disables it;
- terminal restored status leaves a fresh empty enabled input;
- clicking Capture disables the input synchronously before tab/settings awaits;
- delayed/failed `storage.sync.get` leaves capture clickable and shows `Defaults unavailable` in the defaults region;
- unload cancels polling without changing the additions draft.

Expected: focused suite RED on message shape and controls.

- [ ] **Step 3: Add compact accessible markup**

Insert before the capture button:

```html
<section class="capture-tags" aria-labelledby="capture-tags-label">
  <div id="capture-tags-label" class="field-label">Defaults</div>
  <div id="default-tags" class="tag-list" aria-live="polite">Loading…</div>
  <label class="field-label" for="additional-tags">Additional tags</label>
  <input id="additional-tags" type="text" autocomplete="off"
         placeholder="research, reading" aria-describedby="additional-tags-help">
  <p id="additional-tags-help" class="field-help">Applies only to this capture.</p>
</section>
```

Style chips, input, focus ring, wrapping, disabled state, and help copy within the existing compact monochrome popup. Keep native semantic elements and at least 24 CSS-pixel interactive height.

- [ ] **Step 4: Implement popup state without settings mutation**

Read defaults for display only. Render immutable spans with text content, not HTML. On storage failure, render `Defaults unavailable`; continue with `DEFAULT_SETTINGS` for reachability display and let the worker own authoritative settings.

Normalize `additionalInput.value.split(",")` at click time and send:

```ts
await requestCaptureStart(target.id, additionalTags);
```

`renderStatus` sets `additionalInput.disabled = isInProgress(status.phase)`. During initialization, copy `status.additionalTags.join(", ")` into the input only when status is active; terminal status does not restore the old attempt's additions. Start handling disables button and input synchronously; `finally` re-enables through the rendered terminal/error state, not an unconditional assignment that could race a live capture.

- [ ] **Step 5: Run Task 3 focused verification**

Run:

```bash
bun run test src/popup/popup.test.ts src/background/service-worker.test.ts
bun run typecheck
bun run lint
```

Expected: popup and worker tests PASS; typecheck/lint clean.

- [ ] **Step 6: Commit Task 3**

```bash
git add extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/popup/popup.test.ts
git commit -m "feat(extension): add tags to individual captures"
```

---

### Task 4: Metadata-Only Tag Editing on Archived Folios

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.readonly.test.tsx`
- Modify: `ui/src/editor/__tests__/usePageEditor.test.tsx`

**Interfaces:**
- Consumes: existing `TagInput` props (`values`, `readOnlyValues`, suggestions, `onChange`, `onBlur`)
- Consumes: `editor.setTags(tags)` and `editor.saveNow()`
- Invariant: archive tag editing is enabled only for `bodyProtected && editor.archive`; conversation/recipe read presentation alone does not enable it
- Invariant: a tag-only save sends `expected_revision` and `tags`, omitting `body`

- [ ] **Step 1: Add RED archive header interaction tests**

Extend `Folio.readonly.test.tsx` with an archive editor containing ordinary `['saved']` and computed `['archive']` tags. Assert body remains read-only and title has no textbox, while the named Tags textbox exists. Add `reading`, remove `saved`, and assert `setTags` receives the changed ordinary arrays while no computed-tag remove button exists.

Use user-visible queries:

```ts
const tags = screen.getByRole("textbox", { name: "Archive tags" });
await user.type(tags, "reading{Enter}");
expect(state.setTags).toHaveBeenCalledWith(["saved", "reading"]);
```

Blur and assert `saveNow` is called. Render a NOTE, conversation read mode, and recipe read mode without archive metadata and assert none exposes `Archive tags`.

Expected: RED because protected pages render static tags.

- [ ] **Step 2: Wire `TagInput` into the protected archive header**

Import `TagInput` into `Folio.tsx`. Define an optional `archiveTagEditor` prop contract on `ReadOnlyPageHeader` rather than making every read-only presentation editable:

```ts
type ArchiveTagEditorProps = {
  values: string[];
  computedValues: string[];
  suggestions: string[];
  onSuggestionQueryChange: (query: string) => void;
  suggestionsLoading: boolean;
  suggestionsError: Error | null;
  onRetrySuggestions: () => void;
  onChange: (tags: string[]) => void;
  onBlur: () => void;
};
```

Construct it only when `bodyProtected && editor.archive` and pass existing debounced suggestion state, `editor.setTags`, and a flush function that consumes `editor.saveNow()` rejection because the save indicator owns error display:

```ts
onBlur: () => {
  void Promise.resolve(editor.saveNow()).catch(() => undefined);
},
```

Render:

```tsx
<TagInput
  label="Tags"
  ariaLabel="Archive tags"
  values={archiveTagEditor.values}
  readOnlyValues={archiveTagEditor.computedValues}
  suggestions={archiveTagEditor.suggestions}
  onSuggestionQueryChange={archiveTagEditor.onSuggestionQueryChange}
  suggestionsLoading={archiveTagEditor.suggestionsLoading}
  suggestionsError={archiveTagEditor.suggestionsError}
  onRetrySuggestions={archiveTagEditor.onRetrySuggestions}
  onChange={archiveTagEditor.onChange}
  onBlur={archiveTagEditor.onBlur}
  placeholder="Add tag..."
/>
```

Keep the static tag `<dl>` path for non-archive read-only presentations.

- [ ] **Step 3: Prove tag-only update payload omits body**

Add a test in `usePageEditor.test.tsx` that loads a protected archive, calls `setTags(['saved', 'reading'])`, flushes `saveNow`, and expects the page mutation body to equal:

```ts
{
  expected_revision: "rev-a",
  tags: ["saved", "reading"],
}
```

Assert `body` is not an own property. Return an updated revision and tags, then verify save state is `saved`. Existing conflict tests already prove draft preservation and explicit conflict recovery; run them unchanged in the focused file.

- [ ] **Step 4: Run Task 4 focused verification**

Run:

```bash
bun run test -- src/components/codex/__tests__/Folio.readonly.test.tsx src/editor/__tests__/usePageEditor.test.tsx
bun run typecheck
bun run lint
```

Expected: focused UI tests PASS; typecheck/lint clean; ordinary Folio tag tests remain unchanged.

- [ ] **Step 5: Commit Task 4**

```bash
git add ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.readonly.test.tsx ui/src/editor/__tests__/usePageEditor.test.tsx
git commit -m "feat(ui): edit tags on archived folios"
```

---

### Task 5: Documentation, Runtime Proof, and Integration Gates

**Files:**
- Modify: `extension/README.md`
- Modify: `ui/src/docs/content/browser-extension.mdx`
- Modify: `ui/src/docs/content/capture-feeds-and-archives.mdx`

**Interfaces:**
- Documents: defaults are immutable in popup; additions affect one capture; archived ordinary tags are amendable
- Documents: runtime code accepts browser or chrome namespace; packaged targets remain Chromium and Firefox; Safari packaging/support is absent
- Acceptance: real Chromium capture proves manifest and Folio behavior without changing archive body/snapshot hashes

- [ ] **Step 1: Update user documentation**

Add exact workflow copy:

```md
Configured default tags are always included. The popup's Additional tags field applies only to the capture you are starting and does not change Settings. After capture, ordinary tags can be added or removed from the archived Folio; its captured body and snapshot remain protected.
```

State the compatibility boundary accurately:

```md
The runtime selects a native `browser` WebExtension namespace when present and otherwise uses `chrome`. Clepsydra currently builds and verifies Chromium MV3 and Firefox MV2 packages. Safari conversion, signing, packaging, and runtime support are not provided.
```

Do not imply that browser-only bundle initialization equals Safari certification.

- [ ] **Step 2: Run changed-contract suites before runtime work**

Extension:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
bun run build:firefox
```

UI:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Expected: every command exits 0. Record exact test-file/test counts and any warnings separately from failures.

- [ ] **Step 3: Exercise a real Chromium capture**

Load `extension/dist` unpacked in a clean Chromium profile against the running Clepsydra server. Configure defaults `archive-default, research`. Serve a deterministic local HTML fixture and enter additions `#research, reading, archive-default`.

Observe and record:

1. popup displays immutable defaults and editable additions;
2. capture starts and reaches `done`;
3. close/reopen during a delayed capture retains and disables additions;
4. stored page tags appear in exact order: system tags first, then `archive-default`, `research`, `reading`, with overlaps once;
5. no popup action changes `storage.sync.settings.default_tags`.

Delete the runtime archive fixture after verification.

- [ ] **Step 4: Exercise archived Folio tag editing**

Before editing, record page body checksum, `content_hash`, `source_hash`, `snapshot_hash`, and snapshot link. In the real UI add `reviewed`, remove one ordinary tag, reload the Folio, and verify:

- tag changes persist;
- computed tags remain and have no remove control;
- title and body remain read-only;
- body checksum and all archive hashes are unchanged; and
- snapshot link still opens the same resource.

- [ ] **Step 5: Run repository Rust gates**

Even without expected Rust changes, run required integration gates from repository root:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

If `cargo fmt --check` reports pre-existing files outside this branch, run `rustfmt --edition 2024 --check` only on changed Rust files (if none, record that fact) and report the baseline debt without modifying unrelated files. Clippy and tests must pass or the branch remains blocked.

- [ ] **Step 6: Review the complete branch**

Request independent reviews of:

- WebExtension namespace and MV2/MV3 behavior;
- attempt ownership/session persistence and tag merge semantics;
- popup accessibility/lifecycle;
- archive metadata-only save behavior; and
- docs/runtime evidence.

Resolve every Critical/Important finding with a focused RED test and separate commit. Re-run affected focused suites after each fix, then rerun all gates once.

- [ ] **Step 7: Commit documentation and any review fixes**

```bash
git add extension/README.md ui/src/docs/content/browser-extension.mdx ui/src/docs/content/capture-feeds-and-archives.mdx
git commit -m "docs: explain capture and archive tags"
```

Use separate `fix(...)` commits for reviewed code changes; do not fold them into the documentation commit.

- [ ] **Step 8: Merge and clean up**

Confirm the feature worktree is clean. Merge `feature/capture-tags-webext` into `develop` with `--no-ff` from a clean integration worktree when the primary checkout contains unrelated work. Re-run extension and UI changed-contract gates on the merged tree. Then remove the feature/integration worktrees and delete the fully merged feature branch. Preserve all unrelated primary-workspace files.
