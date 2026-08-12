# Stray Thoughts P2 Wave 4 Implementation Plan

**Goal:** Add an explicit-apply raw Markdown mode to editable Folios without creating a second persistence path.

**Source design:** `docs/superpowers/specs/2026-08-11-stray-thoughts-p2-program-design.md`, Wave 4.

**Scope:** UI only. The existing `usePageEditor` mutation, autosave, revision, encryption, and conflict machinery remains authoritative.

## Contracts

1. Entering raw mode snapshots `editor.getPlaintext()` and `editor.getRevision()` synchronously. The snapshot therefore includes the current unsaved rich draft rather than stale server Markdown.
2. Raw keystrokes mutate only local raw state. They do not call `onSlateChange`, `setBodyMarkdown`, or any API.
3. **Cancel** discards only the local raw draft and remounts the unchanged rich editor.
4. **Apply** checks that the page revision still matches the entry snapshot, then calls `setBodyMarkdown` exactly once. `setBodyMarkdown` converts before mutating editor refs so a conversion exception cannot leak a body override into a later metadata save.
5. A conversion failure keeps the exact authored text visible and reports an actionable diagnostic. A revision mismatch does the same and never applies over the newer page.
6. Dirty raw state enables browser and internal-navigation blocking. The confirmation offers **Stay** and **Leave**; unchanged raw state does not block.
7. Locked Folios and declaratively read-only presentations expose no raw action. AI conversation and recipe Folios expose it only from their explicit Edit state.
8. Apply returns through the existing rich/structured presentation and existing autosave/revision-conflict UI. No endpoint, query key, mutation, or compatibility path is added.

## Task 1: Make raw body application atomic

**Files:**
- `ui/src/editor/usePageEditor.ts`
- `ui/src/editor/__tests__/usePageEditor.raw-body.test.tsx`

1. Add a failing regression proving a Markdown conversion exception leaves the previously authored body as the next save source.
2. Move conversion ahead of `bodyOverrideRef` and editor-value mutation in `setBodyMarkdown`.
3. Keep successful conversion and autosave behavior unchanged.
4. Run the focused hook test.

**Commit:** `fix(editor): apply raw body atomically`

## Task 2: Add explicit raw Markdown controls

**Files:**
- `ui/src/components/codex/RawMarkdownEditor.tsx` (new)
- `ui/src/components/codex/RawMarkdownEditor.test.tsx` (new)
- `ui/src/components/codex/Folio.tsx`
- `ui/src/components/codex/__tests__/Folio.test.tsx`
- focused AI conversation and recipe Folio tests only when their existing harnesses require coverage

1. Write failing behavior tests for current-draft entry, unchanged switching, Cancel, one-call Apply, conversion diagnostics with exact text retention, revision mismatch, and read-only/locked affordance absence.
2. Add a compact raw editor with a labelled plain textarea and explicit Apply/Cancel controls. Keep it controlled and persistence-agnostic.
3. Integrate raw session state in `Folio`: path, entry revision, exact snapshot, current value, and diagnostic.
4. Add a Raw Markdown action only when the active presentation is editable.
5. On Apply, compare the current revision, call `setBodyMarkdown` once inside a guarded boundary, and close raw mode only on success.
6. On Cancel, close raw mode without touching page-editor mutation callbacks.
7. Add `useBlocker` protection only while the raw draft differs from its snapshot, with Stay/Leave resolution.
8. Reset an unchanged raw session on path change; preserve dirty drafts behind the navigation blocker.
9. Run focused Folio and raw-editor tests.

**Commit:** `feat(folio): add explicit raw Markdown mode`

## Task 3: Review, smoke, verify, and integrate

1. Package and review the Wave 4 diff against the source design. Correct every Critical/Important finding with a focused regression and one scoped re-review.
2. Run focused raw-mode tests.
3. Run desktop and 390px browser smoke against a disposable vault:
   - make an unsaved rich edit and enter raw mode;
   - Cancel and observe the rich draft unchanged;
   - enter again, edit raw text, Apply, save/reload, and observe the round trip;
   - verify unchanged entry/Cancel emits no save;
   - verify dirty route-away prompts and Stay retains exact input;
   - verify a simulated newer revision retains raw input with a diagnostic;
   - verify locked/read-only Folios have no raw action.
4. Run UI gates: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`.
5. Merge into `develop` while preserving unrelated local work, rerun the same gates, remove the worktree and branch, then mark the source-note checkbox complete through the vault MCP.

**Commit:** reviewed corrections only; merge commit on `develop`.
