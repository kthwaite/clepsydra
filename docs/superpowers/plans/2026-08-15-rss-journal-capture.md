# RSS Journal Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable inline RSS-entry capture flow that appends Markdown to today’s journal, plus a Markdown Copy Link fallback.

**Architecture:** Keep the change inside the existing React feed reader. Task 1 establishes one pure safe Markdown-link formatter and wires the shared clipboard hook. Task 2 consumes that formatter to drive a local inline composer through the existing `useQuickCapture()` and `useOpenTodayJournal()` hooks, then documents the shipped behavior.

**Tech Stack:** React 19, TypeScript, React Aria Components, TanStack Query mutation hooks, Testing Library, Vitest, Tailwind utility classes.

**Spec:** `docs/superpowers/specs/2026-08-15-rss-journal-capture-design.md`

## Global Constraints

- TSK-0064 changes the existing React feed-reader surface only. It MUST NOT add or change Rust, REST, OpenAPI, feed persistence, journal file format, or editor behavior.
- Reuse `useQuickCapture()`, `useOpenTodayJournal()`, and `useCopyToClipboard()`; a second journal or clipboard convention is prohibited.
- **Copy link** copies `[escaped title](safe URL)`; the composer initializes to `- [escaped title](safe URL)`.
- Only absolute `http:` and `https:` URLs admitted by `safeFeedEntryUrl` may expose link-derived actions.
- Capture submits the draft with leading/trailing whitespace trimmed and internal whitespace unchanged.
- Capture MUST NOT alter feed read, bookmark, or tag state and MUST NOT navigate away automatically.
- Capture failure preserves the exact untrimmed draft and remains retryable.
- Use React Aria `Button`, semantic form/label/textarea, `role="status"` for success, and `role="alert"` for failure.
- Follow strict RED/GREEN TDD: every production behavior begins with a focused test that is observed failing for the missing behavior.
- No new dependency, palette, typeface, modal, popover, generic card, backend endpoint, or schema regeneration.

---

### Task 1: Safe Markdown Link and Clipboard Action

**Files:**
- Modify: `ui/src/components/codex/FeedReaderPane.tsx:1-359`
- Test: `ui/src/components/codex/FeedReaderPane.test.tsx:1-285`

**Interfaces:**
- Consumes: existing `safeFeedEntryUrl(value): string | null`; existing `useCopyToClipboard(resetMs?): { copied: boolean; copy(text): Promise<void> }`.
- Produces: exported `feedEntryMarkdownLink(title: string, url: string | null | undefined): string | null`; a reader **Copy link** action that copies the helper’s non-null result and changes its label to **Copied** only after successful clipboard settlement.

- [ ] **Step 1: Add failing formatter tests**

Add table-driven assertions beside the existing `safeFeedEntryUrl` tests:

```ts
expect(
  feedEntryMarkdownLink("Stored dispatch", "https://source.example/posts/stored"),
).toBe("[Stored dispatch](https://source.example/posts/stored)");
expect(
  feedEntryMarkdownLink("A [bracket]", "http://source.example/plain"),
).toBe(String.raw`[A \[bracket\]](http://source.example/plain)`);
expect(
  feedEntryMarkdownLink(String.raw`A \ B`, "https://source.example/slash"),
).toBe(String.raw`[A \\ B](https://source.example/slash)`);
expect(feedEntryMarkdownLink("Unsafe", "javascript:alert(1)")).toBeNull();
expect(feedEntryMarkdownLink("Missing", null)).toBeNull();
```

Import the wished-for helper from `FeedReaderPane`. Name the test so reverting title escaping or URL validation makes it fail.

- [ ] **Step 2: Run the formatter test and verify RED**

Run:

```bash
bun run test -- src/components/codex/FeedReaderPane.test.tsx -t "builds safe Markdown entry links"
```

Expected: FAIL because `feedEntryMarkdownLink` is not exported.

- [ ] **Step 3: Implement the minimal formatter**

In `FeedReaderPane.tsx`, add:

```ts
export function feedEntryMarkdownLink(
  title: string,
  url: string | null | undefined,
): string | null {
  const safeUrl = safeFeedEntryUrl(url);
  if (!safeUrl) return null;
  const label = title.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${label}](${safeUrl})`;
}
```

Keep URL validation centralized in `safeFeedEntryUrl`.

- [ ] **Step 4: Run the formatter test and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Add failing Copy Link component tests**

Extend the hoisted mocks with a shared clipboard-hook result:

```ts
copy: vi.fn().mockResolvedValue(undefined),
copyState: { copied: false },
```

Mock `#/hooks/useCopyToClipboard`, render the stored entry, press **Copy link**, and assert:

```ts
expect(paneMocks.copy).toHaveBeenCalledWith(
  "[Stored dispatch](https://source.example/posts/stored)",
);
```

Rerender with `copyState.copied = true` and assert the button’s accessible/visible name is **Copied**. In the unsafe-URL existing test, assert **Open original** and **Copy link** are both absent. Task 2 adds the corresponding **Capture in journal** assertion after that action exists.

- [ ] **Step 6: Run the Copy Link test and verify RED**

Run:

```bash
bun run test -- src/components/codex/FeedReaderPane.test.tsx -t "copies the safe entry as Markdown"
```

Expected: FAIL because the button is absent.

- [ ] **Step 7: Wire the shared clipboard hook**

Import `useCopyToClipboard`, call it once in `FeedReaderPane`, derive `markdownLink` from the current entry, and pass the non-null link plus copied/copy state into `ReaderArticle`. Add a React Aria `Button` in the existing action row:

```tsx
<Button
  className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
  onPress={() => void copy(markdownLink)}
>
  {copied ? "Copied" : "Copy link"}
</Button>
```

Render it only when `markdownLink` is non-null. Do not call `navigator.clipboard` directly and do not add local clipboard errors.

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run:

```bash
bun run test -- src/components/codex/FeedReaderPane.test.tsx
```

Expected: the complete file passes.

- [ ] **Step 9: Commit Task 1**

```bash
git add ui/src/components/codex/FeedReaderPane.tsx ui/src/components/codex/FeedReaderPane.test.tsx
git commit -m "feat(feeds): copy RSS entries as Markdown"
```

---

### Task 2: Inline Journal Capture Composer

**Files:**
- Modify: `ui/src/components/codex/FeedReaderPane.tsx:1-359`
- Modify: `ui/src/components/codex/FeedReaderPane.test.tsx:1-285`
- Modify: `ui/src/docs/content/capture-feeds-and-archives.mdx:122-156`

**Interfaces:**
- Consumes: Task 1 `feedEntryMarkdownLink`; `useQuickCapture().mutateAsync(content: string): Promise<JournalDetail>`; `useOpenTodayJournal(): () => void`; the current entry identity and shared Markdown link passed into `ReaderArticle`.
- Produces: an entry-local inline capture state machine with states closed, editing, pending, failed, and captured; no exported API.

- [ ] **Step 1: Extend hook mocks for the wished-for capture flow**

In `FeedReaderPane.test.tsx`, add hoisted values and module mocks:

```ts
captureAsync: vi.fn(),
captureState: { isPending: false, error: null as unknown, reset: vi.fn() },
openTodayJournal: vi.fn(),
```

Mock `#/api/journal` so `useQuickCapture()` returns `mutateAsync` plus `captureState`, and mock `#/hooks/useOpenTodayJournal` to return `openTodayJournal`. Reset all values in `beforeEach` and resolve capture to a minimal journal detail object because the component ignores the response.

- [ ] **Step 2: Add the failing composer-open contract**

Render a safe entry, press **Capture in journal**, then assert:

```ts
const draft = screen.getByRole("textbox", { name: "Journal entry" });
expect(draft).toHaveValue(
  "- [Stored dispatch](https://source.example/posts/stored)",
);
expect(draft).toHaveFocus();
```

Also assert Cancel is available and no capture request has run.

- [ ] **Step 3: Run the open test and verify RED**

Run:

```bash
bun run test -- src/components/codex/FeedReaderPane.test.tsx -t "opens a focused journal composer"
```

Expected: FAIL because **Capture in journal** is absent.

- [ ] **Step 4: Implement minimal local composer state and rendering**

In `FeedReaderPane` add local state:

```ts
const [isCapturing, setIsCapturing] = useState(false);
const [captureDraft, setCaptureDraft] = useState("");
const [captureError, setCaptureError] = useState<unknown>(null);
const [captured, setCaptured] = useState(false);
```

Instantiate `useQuickCapture()` and `useOpenTodayJournal()`. Reset composer/draft/error/success in the existing `[selectedEntryId]` effect. Add an open callback that initializes `- ${markdownLink}`, clears settlement state, and sets editing true. Pass state and callbacks into `ReaderArticle`.

Render **Capture in journal** only for a non-null Markdown link. Beneath the action row, render a form matching the existing tag editor’s left-accent strip. Use a labelled native `<textarea>` plus React Aria Capture/Cancel buttons. Hold a textarea ref and focus it in an effect that runs only when `isCapturing` becomes true; do not use the lint-prohibited `autoFocus` attribute. Capture is disabled when `captureDraft.trim()` is empty.

- [ ] **Step 5: Run the open test and verify GREEN**

Run the focused open test. Expected: PASS.

- [ ] **Step 6: Add failing settlement, isolation, and reset tests**

Add focused tests that each fail under a plausible regression:

1. **Edited submission** — type leading/trailing whitespace and an internal second line, submit, and expect one `captureAsync` call with only edge whitespace trimmed.
2. **Pending isolation** — rerender with `captureState.isPending = true`; textarea, Capture, and Cancel are disabled and label is **Capturing…**, while Mark read remains enabled; repeated submit cannot issue a second request.
3. **Success** — after resolved submit, form is gone; `role="status"` says **Captured in today’s journal.**; feed PATCH mock is untouched; reader article remains; pressing **Open today’s journal** calls the hook once.
4. **Failure/retry** — first capture rejects with `new Error("journal unavailable")`; draft and form remain, alert contains the concrete message; retry sends the same trimmed draft and then closes.
5. **Cancel** — closes/discards with no request; reopening regenerates the original bullet link rather than the discarded draft.
6. **Entry reset** — open/edit on entry 101, rerender entry 102, and assert composer plus captured/error feedback are absent until explicitly opened for entry 102.
7. **Unsafe URL** — extend the existing unsafe URL rerender to assert all three link-derived actions are absent.

- [ ] **Step 7: Run settlement tests and verify RED**

Run:

```bash
bun run test -- src/components/codex/FeedReaderPane.test.tsx
```

Expected: the new settlement/isolation/reset tests fail because submit behavior and settlement rendering are incomplete.

- [ ] **Step 8: Implement capture settlement exactly**

The submit callback MUST:

```ts
const content = captureDraft.trim();
if (!content || captureMutation.isPending) return;
captureMutation.reset?.();
setCaptureError(null);
try {
  await captureMutation.mutateAsync(content);
  setIsCapturing(false);
  setCaptureDraft("");
  setCaptured(true);
} catch (error) {
  setCaptureError(error);
}
```

Cancel clears composer/draft/error without invoking the mutation. Success renders:

```tsx
<div role="status" aria-live="polite">Captured in today’s journal.</div>
<Button onPress={openTodayJournal}>Open today’s journal</Button>
```

Failure uses `errorMessage(captureError ?? captureMutation.error, "Capture failed. Try again.")` inside `role="alert"`. Keep feed PATCH and capture mutation pending/error channels separate.

- [ ] **Step 9: Run Task 2 component tests and verify GREEN**

Run the complete `FeedReaderPane.test.tsx` file. Expected: all tests pass with no unhandled rejection or act warning.

- [ ] **Step 10: Update private-feed documentation**

After the paragraph describing UNREAD/ALL/SAVED and entry state, add:

```mdx
For an entry with a safe HTTP(S) source URL, **Capture in journal** opens an
editable Markdown draft and appends the submitted text to today’s journal.
The reader stays in place and does not change read or bookmark state. **Copy
link** copies the entry title and source URL as a Markdown link. Neither action
copies the stored article body.
```

- [ ] **Step 11: Verify docs and focused behavior**

Run:

```bash
bun run test -- src/components/codex/FeedReaderPane.test.tsx src/docs/mdx-smoke.test.ts
bun run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 12: Commit Task 2**

```bash
git add ui/src/components/codex/FeedReaderPane.tsx ui/src/components/codex/FeedReaderPane.test.tsx ui/src/docs/content/capture-feeds-and-archives.mdx
git commit -m "feat(feeds): capture RSS entries in today journal"
```
