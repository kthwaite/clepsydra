# Wikilink Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wikilink preview dismissal deterministic, offer page creation beside partial matches, and give unresolved links an accessible missing-page popover with editable-only creation.

**Architecture:** Extend `PageSummary` with aliases, then keep identity comparison in a pure editor utility used by `WikilinkCombobox`. Add a dedicated Floating UI unresolved-link popover and let `WikilinkElement` remain the navigation/mutation boundary. Reuse the existing `resolveOrCreate` operation and preview store rather than adding creation or preview conventions.

**Tech Stack:** Rust/Axum/rusqlite/utoipa, React 19, TypeScript, Slate, Floating UI, Zustand, Vitest/Testing Library, Cargo tests, Playwright/browser smoke verification.

**Spec:** `docs/superpowers/specs/2026-08-13-wikilink-interactions-design.md`

## Global Constraints

- Ordinary Markdown links remain unchanged.
- Missing previews are local, transient popovers; they are not movable, pinnable, minimized, or persisted.
- Creation always uses `useResolveOrCreateWikilinkTarget`; do not add another API or intake-path convention.
- Read-only unresolved links explain but never mutate.
- Modifier activation closes only `previewStore.hoverId`; it never calls `closePath` and never removes pinned/minimized previews.
- Exact identity normalization is NFC + lowercase + collapsed/trimmed whitespace + optional `.md` suffix removal.
- `PageSummary.aliases` is a required `string[]`; pages without aliases serialize `[]`.
- Preserve the eight-page-result cap and existing page ordering; append Create after page rows.
- Run focused tests within each task. Skip formatters, linters, builds, and project-wide suites inside implementation subagents; the parent runs repository gates once after all reviews.

---

### Task 1: Expose aliases in page summaries

**Files:**
- Modify: `src/api/pages.rs:38-52,374-410,481-490`
- Modify: `src/api/folders.rs:257-304,374-430`
- Modify: `tests/api_test.rs:1360-1530`
- Modify: `ui/src/api/schema.d.ts:2360-2371` only through OpenAPI regeneration
- Modify: `ui/src/editor/__tests__/WikilinkCombobox.test.tsx:24-35` to add `aliases: []` to the typed fixture

**Interfaces:**
- Consumes: indexed `pages.meta_json`, whose `aliases` member is a JSON string array when declared.
- Produces: Rust `PageSummary { aliases: Vec<String>, ... }` and generated TypeScript `PageSummary.aliases: string[]`.
- Produces mapper SELECT order: `id, path, title, canonical_name, kind, kind_inferred, project, encrypted, effective_tags, computed_tags, aliases_json`.

- [ ] **Step 1: Write failing API assertions for declared and absent aliases**

In the existing `list_pages` API test fixture, create or update an indexed page with frontmatter aliases and assert both shapes:

```rust
assert_eq!(indexed["aliases"], serde_json::json!(["Design", "Blueprint"]));
assert_eq!(filesystem_only["aliases"], serde_json::json!([]));
```

Also add `aliases: vec![]` to direct `PageSummary` literals in `src/api/folders.rs` tests so compilation identifies every required constructor.

- [ ] **Step 2: Run focused Rust tests and verify failure**

Run:

```bash
cargo test --test api_test list_pages -- --nocapture
cargo test api::folders::tests -- --nocapture
```

Expected: the API assertion fails because `aliases` is absent, and/or compilation fails because `PageSummary` has no `aliases` field.

- [ ] **Step 3: Add aliases to the Rust response and shared row mapper**

Add the field:

```rust
pub struct PageSummary {
    // existing fields
    pub aliases: Vec<String>,
    pub encrypted: bool,
}
```

Extend both summary SELECT statements with a final column:

```sql
COALESCE(json_extract(p.meta_json, '$.aliases'), '[]')
```

Parse it in `page_summary_from_row` without accepting malformed non-array values:

```rust
let aliases_json: String = row.get(10)?;
let aliases: Vec<String> = serde_json::from_str(&aliases_json).map_err(|error| {
    rusqlite::Error::FromSqlConversionFailure(
        10,
        rusqlite::types::Type::Text,
        Box::new(error),
    )
})?;
```

Set `aliases` in the returned summary and set `aliases: Vec::new()` in `build_page_summary_fallback` and all test literals. Update the mapper's column-order comment.

- [ ] **Step 4: Run focused Rust tests and verify pass**

Run the two commands from Step 2.

Expected: PASS; indexed aliases serialize in order and absent/fallback aliases serialize `[]`.

- [ ] **Step 5: Regenerate and verify the OpenAPI TypeScript contract**

Create a disposable server configuration and regenerate from the real endpoint:

1. Run `mktemp -d` and retain the path as `<tmp>`.
2. Run `cargo run -- init <tmp>/vault`.
3. Create `<tmp>/xdg/clepsydra/config.toml` with `server.host = "127.0.0.1"`, `server.port = 3000`, `server.dev_mode = true`, and `vault.root = "<tmp>/vault"`.
4. Start `cargo run -- serve --port 3000` through the harness process manager with `XDG_CONFIG_HOME=<tmp>/xdg`; wait until port 3000 accepts connections.
5. Run:

```bash
bun run --cwd ui openapi
```

6. Stop the temporary server and remove `<tmp>`.


```ts
PageSummary: {
  aliases: string[];
  canonical_name: string;
  // existing required fields
};
```

Do not hand-edit generated schema output.

- [ ] **Step 6: Run contract typecheck**

Run:

```bash
bun run --cwd ui typecheck
```

Expected: PASS with test fixtures updated to include required aliases.

- [ ] **Step 7: Commit the API contract slice**

```bash
git add src/api/pages.rs src/api/folders.rs tests/api_test.rs ui/src/api/schema.d.ts ui/src/editor/__tests__/WikilinkCombobox.test.tsx
git commit -m "feat: expose aliases in page summaries"
```

---

### Task 2: Offer Create beside partial matches

**Files:**
- Create: `ui/src/editor/wikilinkIdentity.ts`
- Create: `ui/src/editor/__tests__/wikilinkIdentity.test.ts`
- Modify: `ui/src/editor/WikilinkCombobox.tsx:17-56`
- Modify: `ui/src/editor/__tests__/WikilinkCombobox.test.tsx:24-123`

**Interfaces:**
- Consumes: `PageSummary.aliases: string[]` from Task 1.
- Produces: `normalizeWikilinkIdentity(value: string): string`.
- Produces: `pageHasExactWikilinkIdentity(page: PageSummary, query: string): boolean`.
- Preserves: `WikilinkSuggestion` union and `onCreate(title)` callback.

- [ ] **Step 1: Write failing normalization and exactness tests**

Create tests equivalent to:

```ts
expect(normalizeWikilinkIdentity("  CAFÉ   Notes.md ")).toBe("café notes");
expect(normalizeWikilinkIdentity("Cafe\u0301 Notes")).toBe("café notes");

const page = {
  ...pageFixture,
  title: "Design Notes",
  canonical_name: "design-notes",
  aliases: ["Blueprint"],
  path: "notes/design-notes.md",
};
expect(pageHasExactWikilinkIdentity(page, " DESIGN NOTES ")).toBe(true);
expect(pageHasExactWikilinkIdentity(page, "blueprint")).toBe(true);
expect(pageHasExactWikilinkIdentity(page, "notes/design-notes")).toBe(true);
expect(pageHasExactWikilinkIdentity(page, "design")).toBe(false);
```

Update the combobox test that currently asserts partial-match suppression. It must assert `Design Notes` followed by `Create “design”`. Add exact-title, canonical, alias, and path suppression cases. Add a keyboard test that presses ArrowDown once from the first page row, then Enter, and expects `onCreate("design")`.

- [ ] **Step 2: Run focused UI tests and verify failure**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/wikilinkIdentity.test.ts src/editor/__tests__/WikilinkCombobox.test.tsx
```

Expected: FAIL because the utility does not exist and the combobox still omits Create when partial matches exist.

- [ ] **Step 3: Implement the pure identity utility**

Implement:

```ts
import type { PageSummary } from "#/api/types";

export function normalizeWikilinkIdentity(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/\.md$/u, "");
}

export function pageHasExactWikilinkIdentity(
  page: PageSummary,
  query: string,
): boolean {
  const expected = normalizeWikilinkIdentity(query);
  if (!expected) return false;
  return [page.title, page.canonical_name, page.path, ...page.aliases]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeWikilinkIdentity(value) === expected);
}
```

Keep the helper editor-local; do not export it through a package barrel.

- [ ] **Step 4: Append Create after matching page rows**

Build suggestions as page rows plus an optional trailing create row:

```ts
const exactIdentityExists = filteredPages.some((page) =>
  pageHasExactWikilinkIdentity(page, trimmedQuery),
);
const suggestions: WikilinkSuggestion[] = [
  ...filteredPages.map((page) => ({ kind: "page" as const, page })),
  ...(trimmedQuery && !exactIdentityExists
    ? [{ kind: "create" as const, title: trimmedQuery }]
    : []),
];
```

Do not change filtering, result ordering, the eight-row page cap, pending/retry copy, or `EditorSuggestionPopover` keyboard behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/wikilinkIdentity.test.ts src/editor/__tests__/WikilinkCombobox.test.tsx
bun run --cwd ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the combobox slice**

```bash
git add ui/src/editor/wikilinkIdentity.ts ui/src/editor/__tests__/wikilinkIdentity.test.ts ui/src/editor/WikilinkCombobox.tsx ui/src/editor/__tests__/WikilinkCombobox.test.tsx
git commit -m "feat: offer wikilink creation beside partial matches"
```


---

### Task 3: Add the unresolved wikilink popover

**Files:**
- Create: `ui/src/editor/MissingWikilinkPopover.tsx`
- Create: `ui/src/editor/__tests__/MissingWikilinkPopover.test.tsx`

**Interfaces:**
- Produces:

```ts
type MissingWikilinkPopoverProps = {
  target: string;
  readOnly: boolean;
  creating: boolean;
  error: string | null;
  onCreate: () => Promise<boolean>;
  children: ReactNode;
};
```

- Consumes: `@floating-ui/react` interaction primitives already installed in `ui/package.json`.
- Does not consume editor, API, preview-store, or navigation state.

- [ ] **Step 1: Write failing accessible behavior tests**

Cover these observable contracts with Testing Library and fake timers only where hover delay requires them:

```tsx
render(
  <MissingWikilinkPopover
    target="Unwritten Page"
    readOnly={false}
    creating={false}
    error={null}
    onCreate={onCreate}
  >
    <span role="link" tabIndex={0}>Unwritten Page</span>
  </MissingWikilinkPopover>,
);
```

Assert:

- focus opens a dialog containing `Page does not exist` and `Unwritten Page`;
- editable mode exposes `Create page`, calls `onCreate` once, closes when it resolves `true`, and stays open when it resolves `false`;
- read-only mode has no Create button;
- `creating` renders `Creating…` and disables the button;
- `error="Creation failed"` displays the message and leaves Create retryable;
- Escape closes and restores focus to the link trigger;
- pointer transfer from trigger to floating surface does not close it;
- outside pointer interaction closes it.

- [ ] **Step 2: Run the component test and verify failure**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/MissingWikilinkPopover.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal Floating UI component**

Use controlled internal open state with `useFloating`, `offset(6)`, `flip()`, `shift({ padding: 8 })`, `autoUpdate`, `useHover(..., { handleClose: safePolygon() })`, `useFocus`, `useDismiss`, `useRole(..., { role: "dialog" })`, `useInteractions`, `FloatingPortal`, and `FloatingFocusManager` configured not to steal initial focus on hover.

Clone the single child to attach reference and interaction props. Render the floating surface only while open:

```tsx
<div className="z-50 w-64 border border-ink bg-paper p-3 shadow-[4px_4px_0_0_var(--color-ink)]">
  <p className="cl-cap text-[9px] text-ink-mute">Missing page</p>
  <p className="mt-1 font-medium text-ink">{target}</p>
  <p className="mt-1 text-xs text-ink-mute">Page does not exist.</p>
  {!readOnly && (
    <button
      type="button"
      disabled={creating}
      onClick={async () => {
        if (await onCreate()) setOpen(false);
      }}
    >
      {creating ? "Creating…" : "Create page"}
    </button>
  )}
  {error && <p role="alert">{error}</p>}
</div>
```

Use existing button/typography classes from adjacent editor popovers; do not add a generic popover abstraction or modify `CLink`.

- [ ] **Step 4: Run focused component tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the presentation slice**

```bash
git add ui/src/editor/MissingWikilinkPopover.tsx ui/src/editor/__tests__/MissingWikilinkPopover.test.tsx
git commit -m "feat: add missing wikilink popover"
```

---

### Task 4: Integrate creation and deterministic preview dismissal

**Files:**
- Modify: `ui/src/editor/elements/WikilinkElement.tsx:1-138`
- Modify: `ui/src/editor/__tests__/WikilinkElement.test.tsx:16-355`
- Modify: `ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx` for real preview-store integration
- Modify: `ui/src/docs/content/links-search-graph-and-repair.mdx:25-41`

**Interfaces:**
- Consumes: `MissingWikilinkPopover` from Task 3.
- Consumes: `useResolveOrCreateWikilinkTarget().resolveOrCreate(target)` and `useOpenTab()`.
- Consumes: `usePreviewStore.getState().hoverId` and `.close(id)`.
- Preserves: plain editable click starts inline editing; active inline editor flow; read-only resolved navigation.

- [ ] **Step 1: Write failing element tests for preview policy and popover integration**

Extend the `CLink` mock only for resolved branches; let the unresolved branch render the real `MissingWikilinkPopover`. Reset the real preview store in `beforeEach`.

Add tests that seed a transient preview window, Cmd/Ctrl-click a resolved link, and assert:

```ts
expect(usePreviewStore.getState().hoverId).toBeNull();
expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
```

Seed a pinned preview plus a separate transient preview and assert modifier-click removes only the transient window. Add unresolved integration tests that focus the trigger, click `Create page`, assert one `resolveOrCreate("New Topic")`, then assert `openTab("page", returned.path)` and unchanged Slate descendants. Add pending double-activation, failure/retry, and read-only no-Create/no-mutation cases.

- [ ] **Step 2: Run focused element tests and verify failure**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/WikilinkElement.test.tsx src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx
```

Expected: FAIL because modifier-click does not explicitly close the transient preview and unresolved links have no popover.

- [ ] **Step 3: Refactor `WikilinkElement` around one guarded activation function**

Add local state for pending/error because it affects rendering:

```ts
const [creating, setCreating] = useState(false);
const [createError, setCreateError] = useState<string | null>(null);
```

Retain `inFlightRef` as the synchronous duplicate guard. Implement:

```ts
const closeTransientPreview = () => {
  const { hoverId, close } = usePreviewStore.getState();
  if (hoverId) close(hoverId);
};

const openTarget = async (target: string): Promise<boolean> => {
  if (inFlightRef.current) return false;
  const current = lookup(target);
  if (current) {
    openTab("page", current);
    return true;
  }
  inFlightRef.current = true;
  setCreating(true);
  setCreateError(null);
  try {
    const result = await resolveOrCreate(target);
    openTab("page", result.path);
    return true;
  } catch {
    setCreateError("Creation failed — try again");
    return false;
  } finally {
    inFlightRef.current = false;
    setCreating(false);
  }
};
```

On every editable Cmd/Ctrl-click, call `closeTransientPreview()` before `void openTarget(element.target)`. On plain editable click, retain transient closure then `controller.begin(...)`.

- [ ] **Step 4: Render resolved and unresolved branches explicitly**

Resolved passive nodes continue through `CLink path={resolved}`. Unresolved passive nodes use `MissingWikilinkPopover` with `target`, `readOnly`, `creating`, `createError`, and `onCreate={() => openTarget(element.target)}` around a dashed link trigger.

The unresolved trigger must call the same click handler so plain editable click enters editing, modifier-click creates/opens, and read-only click is non-mutating. Avoid nested interactive elements: the Create button lives in the portalled popover, not inside the trigger DOM.

`openTarget` returns `true` after it opens a resolved or newly created page and `false` after a failure. `MissingWikilinkPopover` closes only for `true`; navigation remains owned by `WikilinkElement`.

- [ ] **Step 5: Add one real preview lifecycle integration test**

In `SlateEditor.wikilink-editing.test.tsx`, use real `CLink` and preview store. Open a resolved hover preview with fake timers, modifier-click the link, advance pending close timers, and assert the transient preview is gone because activation closed it—not because a delayed mouse-leave happened. Preserve the existing test proving plain click closes a transient preview and starts editing.

- [ ] **Step 6: Update user documentation**

Replace the dangling-link workflow text with the new behavior:

```md
A muted, dashed link is dangling. Hover or focus it to see the missing-page state. In an editable Folio, choose **Create page** or Ctrl/Cmd-click the link to create or reuse a canonical blank note and open it. Read-only Folios explain the missing target but never create it.
```

Document that the `[[` chooser offers Create beside partial matches and suppresses it only for an exact normalized title, canonical name, alias, or path.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/MissingWikilinkPopover.test.tsx src/editor/__tests__/WikilinkElement.test.tsx src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx src/editor/__tests__/WikilinkCombobox.test.tsx
bun run --cwd ui typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the integrated behavior**

```bash
git add ui/src/editor/elements/WikilinkElement.tsx ui/src/editor/__tests__/WikilinkElement.test.tsx ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx ui/src/docs/content/links-search-graph-and-repair.mdx
git commit -m "fix: complete wikilink missing-page interactions"
```

---

### Task 5: Review, verify, and close TSK-0058

**Files:**
- Modify only if review finds a concrete defect: files changed in Tasks 1-4
- Update through vault MCP after merge: `tasks/clepsydra/TSK-0058.md`

**Interfaces:**
- Consumes: the complete feature branch.
- Produces: reviewed commits, repository-gate evidence, browser-smoke evidence, merged `develop`, and a SEALED task with all three checks complete.

- [ ] **Step 1: Run spec-compliance review**

Review each task commit against `docs/superpowers/specs/2026-08-13-wikilink-interactions-design.md`. Reject additions outside scope, especially generic `CLink` changes, a preview-store union, a second creation API, or read-only mutation.

- [ ] **Step 2: Run code-quality review**

Check accessibility, timer cleanup, focus restoration, stale async updates after unmount, duplicate activation, generated-schema provenance, query/mapping column order, and fixture completeness. Apply only evidence-backed corrections, rerun their focused tests, and commit corrections separately.

- [ ] **Step 3: Run repository verification gates once**

Run from the feature worktree:

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
cargo test
```

Expected baseline or better:

- UI: at least 273 test files and 3,492 tests, all passing, plus new tests.
- Rust: at least 1,786 tests, all passing, plus new tests.
- Typecheck: exit 0.
- Lint: exit 0.

- [ ] **Step 4: Run actual browser behavior smoke**

Start the Clepsydra server through the process hub, open the UI with the browser tool, and exercise a disposable note containing resolved and unresolved wikilinks.

Verify visibly and behaviorally:

1. hover a resolved wikilink, Cmd-click it, and observe the transient preview disappear while the page opens;
2. type a partial `[[` query, observe matching pages followed by Create;
3. focus/hover an unresolved link, observe `Page does not exist` and `Create page`;
4. create it and observe the canonical page open;
5. render an unresolved link in a read-only surface and observe explanation without Create.

Capture exact observed outcomes. Stop the shared process afterward.

- [ ] **Step 5: Commit any verification correction**

If Step 3 or 4 required code changes, commit them with a precise `fix:` message after rerunning the affected focused check. If no correction was needed, create no empty commit.

- [ ] **Step 6: Merge into `develop` without disturbing user changes**

Confirm the original `develop` checkout still contains the user's unrelated modifications. Merge the feature branch from a clean Git context without resetting, stashing, staging, or overwriting those files. If Git reports an overlap with current user modifications, stop and surface the exact files rather than forcing the merge.

- [ ] **Step 7: Update the vault task**

Through the vault MCP tools, mark all three TSK-0058 checklist lines complete and move the task from TRIAGE to SEALED. Re-read the project-filtered TASKING board and the task page to verify the status and `checks: [3, 3]`.

- [ ] **Step 8: Remove the feature worktree**

After the merge and vault verification, remove `.worktrees/tsk-0058-wikilink-interactions` through `git worktree remove` and delete the merged feature branch. Do not touch the original checkout's unrelated working-tree changes.
