# Clepsydra Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver five bounded user-visible fixes: aligned Folio metadata, correct Slate punctuation and selection boundaries, a local vault backup command, and a derived non-removable journal tag.

**Architecture:** UI changes extend the existing `KV`, `TagInput`, `PageEditorHeader`, and Slate plugin composition points. Backup traversal lives in a focused Rust vault module while the Clap command remains a thin adapter. Each behavior gets an independent red-green cycle and review gate.

**Tech Stack:** React 19, TypeScript, Slate 0.123, React Aria Components, Tailwind CSS, Vitest/Testing Library, Rust 2024, Clap 4, `walkdir`, `tar`, Cargo tests.

## Global Constraints

- Reuse existing Folio, Slate schema/plugin, tag-input, Clap, settings, and vault-resolution patterns.
- Do not add computed-tag indexing/search semantics, remote backup support, compression, scheduling, retention, or restore behavior.
- Punctuation behavior covers `, . ; : ! ?`; brackets and quotes retain existing behavior.
- Backup includes vault content and `.clepsydra` configuration but excludes `.clepsydra/cache.db`, the current final archive, and its temporary file.
- Backup stores symlinks without following them.
- JOURNAL pages derive `journal`; non-JOURNAL pages may still edit an ordinary persisted `journal` tag.
- Every production behavior change must follow red-green-refactor; do not weaken a failing assertion to obtain green.
- Existing unstaged changes in the primary `develop` checkout are out of scope and must remain untouched.

---

### Task 1: Align shared Folio metadata rows

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx:673-681`
- Verify: `ui/src/components/codex/Folio.stories.tsx` or the running Folio route, whichever already supplies a representative page

**Interfaces:**
- Consumes: existing `KV({ k, v }: { k: string; v: React.ReactNode })` helper.
- Produces: the same `KV` signature; rows and value wrappers use centered cross-axis alignment.

- [ ] **Step 1: Establish the failing visual criterion**

Open a Folio whose Document block shows `Kind`, `Project`, and `Protection`. At the default left-rail width and at the 180px minimum, capture the current rendering and verify at least one label is not vertically centered against its interactive value. Record the page and viewport used in the task result.

- [ ] **Step 2: Apply the minimal shared layout change**

Change only the two shared wrappers:

```tsx
function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="cl-mono grid grid-cols-[64px_1fr] items-center gap-2 py-[1px] text-[11px]">
      <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
        {k}
      </span>
      <span className="flex min-w-0 items-center text-ink-2">{v}</span>
    </div>
  );
}
```

Do not alter `KindSelect`, `ProjectCombo`, or the protection button.

- [ ] **Step 3: Verify the visual criterion is green**

Reload the same page and viewport. Confirm all three labels are vertically centered, the Path row still wraps, and controls remain usable at 180px and the default rail width. Capture the corrected rendering for review.

- [ ] **Step 4: Run focused static verification**

Run:

```bash
bun run typecheck
bun run lint ui/src/components/codex/Folio.tsx
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the independent change**

```bash
git add ui/src/components/codex/Folio.tsx
git commit -m "fix(ui): align folio metadata rows"
```

---

### Task 2: Exit inline styling for trailing punctuation

**Files:**
- Create: `ui/src/editor/plugins/withInlinePunctuationBoundary.ts`
- Create: `ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts`
- Modify: `ui/src/editor/SlateEditor.tsx:128-135`

**Interfaces:**
- Consumes: a Slate `Editor` whose schema already classifies Markdown links as inline elements.
- Produces: `withInlinePunctuationBoundary(editor: Editor): Editor`, preserving the editor identity and overriding `insertText(text: string): void`.
- Composition contract: place this plugin inside `withReact` and outside `withSchema`, so it delegates to the fully configured schema editor and React sees the final editor methods.

- [ ] **Step 1: Write failing structural tests**

Create an editor helper using `withInlinePunctuationBoundary(withSchema(withHistory(createEditor())))`, assign paragraph children directly, select the required point, and call `editor.insertText`.

Add separate tests that assert:

```ts
expect(slateToMarkdown(editor.children)).toBe("[label](https://example.test),");
expect(slateToMarkdown(editor.children)).toBe("**bold**, plain");
```

Also assert these preserved behaviors:

```ts
expect(slateToMarkdown(editor.children)).toBe("[lab,el](https://example.test)");
expect(slateToMarkdown(editor.children)).toBe("[labelx](https://example.test)");
```

Use table-driven cases for `,`, `.`, `;`, `:`, `!`, and `?`, but keep inside-link and normal-letter continuation as named tests.

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
bun run test ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts
```

Expected: FAIL because the plugin module does not exist or because punctuation remains inside the link/marked leaf. Resolve import/setup errors until the failure is the behavioral mismatch.

- [ ] **Step 3: Implement the minimal boundary plugin**

Use this public shape:

```ts
import { Editor, Element as SlateElement, Range, Transforms } from "slate";

const TRAILING_PUNCTUATION = /^[,.;:!?]$/;

export function withInlinePunctuationBoundary(editor: Editor): Editor {
  const { insertText } = editor;

  editor.insertText = (text) => {
    const { selection } = editor;
    if (!TRAILING_PUNCTUATION.test(text) || !selection || !Range.isCollapsed(selection)) {
      insertText(text);
      return;
    }

    const inline = Editor.above(editor, {
      at: selection.anchor,
      match: (node) => SlateElement.isElement(node) && editor.isInline(node) && !editor.isVoid(node),
    });

    if (inline && Editor.isEnd(editor, selection.anchor, inline[1])) {
      const after = Editor.after(editor, inline[1]);
      if (after) Transforms.select(editor, after);
    }

    for (const mark of Object.keys(Editor.marks(editor) ?? {})) {
      Editor.removeMark(editor, mark);
    }
    insertText(text);
  };

  return editor;
}
```

Adjust only where the red test demonstrates a Slate API detail differs. Do not inspect or rewrite Markdown strings.

Compose it in `SlateEditor`:

```ts
withReact(
  withInlinePunctuationBoundary(
    withHistory(withAutoformat(withOutliner(withSchema(createEditor())))),
  ),
)
```

- [ ] **Step 4: Verify green and regression cases**

Run the focused test, then:

```bash
bun run test ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx ui/src/editor/convert/__tests__/round-trip.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the independent change**

```bash
git add ui/src/editor/plugins/withInlinePunctuationBoundary.ts ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts ui/src/editor/SlateEditor.tsx
git commit -m "fix(editor): exit inline styles for punctuation"
```

---

### Task 3: Replace a one-character Slate selection once

**Files:**
- Create: `ui/src/editor/__tests__/SlateEditor.selection-replacement.test.tsx`
- Modify only after reproduction identifies the source: `ui/src/editor/SlateEditor.tsx`, `ui/src/editor/plugins/withInlinePunctuationBoundary.ts`, or the responsible existing Slate/Vim adapter

**Interfaces:**
- Consumes: the production `SlateEditor` composition after Task 2 and its real `Editable` input path.
- Produces: no new public API unless root-cause analysis proves a focused plugin is required. The observable contract is expanded-selection replacement followed by a collapsed caret.
- Dependency: begin from Task 2's committed editor composition; do not duplicate or bypass its `insertText` override.

- [ ] **Step 1: Build a real-input regression harness**

Follow the existing `SlateEditor.wikilink-create.test.tsx` harness: capture the active editor by wrapping the real `Slate` provider, render `SlateEditor` under a `QueryClientProvider`, and use `Transforms.select` only to establish the initial expanded selection.

Start from `abc`, select the range covering `b`, focus the real editable, then drive printable input through `userEvent.keyboard`:

```ts
await user.keyboard("xy");
expect(Node.string(editor)).toBe("axyc");
expect(Range.isCollapsed(editor.selection!)).toBe(true);
expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 3 });
```

Add separate tests for `!,` and undo after a single replacement.

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
bun run test ui/src/editor/__tests__/SlateEditor.selection-replacement.test.tsx
```

Expected: FAIL with the retained-selection behavior (`ayc`, repeated overwrite, or a non-collapsed selection). If it passes, reproduce in the running browser and transfer the exact DOM event sequence into the test; do not add production code until the regression test fails for the observed reason.

- [ ] **Step 3: Trace the failing input path**

Inspect, in order, the captured editor selection before input, the `Editable` `onDOMBeforeInput` path, Vim's disabled-mode result, and every production `insertText` override. State the root cause in the task result before editing production code.

The admissible fix must preserve this invariant:

```ts
if (editor.selection && Range.isExpanded(editor.selection)) {
  Transforms.delete(editor);
}
insertText(text);
```

Implement it only at the single shared boundary responsible for the retained range. Do not add character-specific `onKeyDown` branches or timers.

- [ ] **Step 4: Verify green and history behavior**

Run:

```bash
bun run test ui/src/editor/__tests__/SlateEditor.selection-replacement.test.tsx ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts ui/src/editor/__tests__/SlateEditor.vim-toggle.test.tsx
```

Expected: replacement, repeated typing, punctuation, undo, punctuation-boundary, and Vim tests all pass.

- [ ] **Step 5: Commit the independent change**

```bash
git add ui/src/editor/__tests__/SlateEditor.selection-replacement.test.tsx ui/src/editor/SlateEditor.tsx ui/src/editor/plugins/withInlinePunctuationBoundary.ts
git commit -m "fix(editor): collapse replaced text selections"
```

Stage only files actually changed; omit unchanged paths from `git add`.

---

### Task 4: Add the local vault backup command

**Files:**
- Modify: `Cargo.toml:10-56`
- Modify: `Cargo.lock`
- Create: `src/vault/backup.rs`
- Modify: `src/vault/mod.rs:1-49`
- Modify: `src/bin/cli.rs:10-198,200-395,410-695`

**Interfaces:**
- Consumes: resolved vault root from `Settings::load`, `resolve_vault_root`, filesystem traversal from `walkdir`, and tar writing from `tar`.
- Produces:

```rust
pub fn create_backup(
    vault_root: &Path,
    destination: &Path,
    timestamp: DateTime<Utc>,
) -> Result<PathBuf, BackupError>;
```

Use one contextual I/O variant and one traversal variant:

```rust
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("{operation} `{path}`: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("walk vault `{root}`: {source}")]
    Walk {
        root: PathBuf,
        #[source]
        source: walkdir::Error,
    },
}
```
- CLI surface: `Commands::Backup { destination: PathBuf }` from `clep backup --destination <directory>`.

- [ ] **Step 1: Add the dependency and write failing module tests**

Add `tar = "0.4"` under `[dependencies]`, export `pub mod backup;`, and create tests in `src/vault/backup.rs` using `tempfile::TempDir` and a fixed UTC timestamp.

The first test creates:

```text
vault/
  notes/a.md
  _attachments/image.bin
  .clepsydra/config.toml
  .clepsydra/cache.db
```

Call the wished-for API and read the archive with `tar::Archive`. Assert relative entry names contain the page, attachment, and config, and omit `.clepsydra/cache.db`.

Add independent tests for:

- creating a missing destination directory;
- destination inside the vault while excluding the current `.tar` and `.partial` paths;
- storing a symlink without archiving its target contents on Unix;
- rejecting an existing non-directory destination; and
- deleting an existing partial file when a private `PartialArchive` cleanup guard is dropped without `commit()`.

- [ ] **Step 2: Run focused Rust tests and verify red**

Run:

```bash
cargo test vault::backup --lib
```

Expected: FAIL because `create_backup` and `BackupError` are not implemented. Resolve compile-only test mistakes until at least one assertion fails for missing behavior.

- [ ] **Step 3: Implement archive creation minimally**

Implement `BackupError` with `thiserror`, a timestamped filename using `%Y%m%dT%H%M%SZ`, `create_dir_all`, `OpenOptions::create_new(true)`, `tar::Builder::follow_symlinks(false)`, and `WalkDir` with deterministic path ordering before append.

Skip exact relative path `.clepsydra/cache.db` and exact absolute paths for the current final and partial archive. Append directories and entries with vault-relative names. A private `PartialArchive { path: PathBuf, builder: Option<tar::Builder<File>>, committed: bool }` guard owns cleanup in `Drop`; `commit(final_path)` takes the builder, finishes and syncs the tar, renames it, marks the guard committed, and returns the final path. This gives every early error path the same partial-file cleanup and a deterministic unit-test seam.

Return the final absolute or resolved destination path. Do not exclude unrelated older archives.

- [ ] **Step 4: Add failing CLI parser/dispatch tests**

In `cli_tests`, parse:

```rust
let cli = Cli::try_parse_from(["clep", "backup", "--destination", "out"]).unwrap();
assert!(matches!(cli.command, Commands::Backup { destination } if destination == PathBuf::from("out")));
```

For dispatch, use a temporary application config pointing to a temporary vault, invoke `run_cli`, and assert exit 0 plus exactly one resulting tar in the destination. Keep process-global current-directory or environment changes serialized and restored using the suite's existing pattern.

Run the targeted CLI tests and verify the parser test fails before adding the enum variant/dispatch arm.

- [ ] **Step 5: Implement the thin Clap adapter**

Add the command variant with required `--destination <directory>`, load settings from current directory, resolve the vault root, call `create_backup(..., Utc::now())`, and print only `path.display()` on stdout.

Update the top-level CLI examples with:

```text
clep backup --destination ~/Backups
```

- [ ] **Step 6: Verify module and CLI green**

Run:

```bash
cargo test vault::backup --lib
cargo test --bin clep cli_tests
cargo check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the independent change**

```bash
git add Cargo.toml Cargo.lock src/vault/backup.rs src/vault/mod.rs src/bin/cli.rs
git commit -m "feat(cli): add local vault backup command"
```

---

### Task 5: Derive a non-removable journal tag

**Files:**
- Modify: `ui/src/components/ui/tag-input.tsx:12-128`
- Modify: `ui/src/components/ui/__tests__/tag-input.test.tsx`
- Modify: `ui/src/editor/PageEditorHeader.tsx:4-118`
- Modify: `ui/src/editor/__tests__/PageEditorHeader.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx:47-130,359-376`
- Modify: `ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx`

**Interfaces:**
- Extends `TagInputProps` with `readOnlyValues?: string[]`.
- Extends `PageEditorHeaderProps` with `derivedTags?: string[]` and forwards them as `readOnlyValues`.
- `TagInput.onChange` continues to emit editable `values` only.
- `Folio` passes `derivedTags={kind === "JOURNAL" ? ["journal"] : []}` and filters `journal` from editable tags only when resolved kind is JOURNAL.

- [ ] **Step 1: Write failing `TagInput` behavior tests**

Render:

```tsx
<TagInput
  label="Tags"
  values={["pkm"]}
  readOnlyValues={["journal"]}
  onChange={onChange}
/>
```

Assert `journal` and `pkm` are visible, only `pkm` exposes a remove control, Backspace with an empty input removes `pkm` but never `journal`, and adding `journal` does not emit a duplicate editable value. Assert `onChange` payloads never contain read-only values unless they were already independently present in `values` on a non-derived caller.

- [ ] **Step 2: Run the component test and verify red**

Run:

```bash
bun run test ui/src/components/ui/__tests__/tag-input.test.tsx
```

Expected: FAIL because `readOnlyValues` is not supported and no read-only chip renders.

- [ ] **Step 3: Implement read-only values in `TagInput`**

Default `readOnlyValues = []`. Render them in a separate `TagGroup` without `onRemove`, using the existing chip classes and no remove-slot `Button`. Change duplicate checks and placeholder visibility to consider both arrays. Keep Backspace and `handleRemove` scoped to editable `values`.

- [ ] **Step 4: Verify `TagInput` green**

Run the focused component test. Expected: all existing and new tag-input tests pass.

- [ ] **Step 5: Write failing header and Folio tests**

Extend `PageEditorHeader.test.tsx` to assert `derivedTags={["journal"]}` renders an immutable chip while ordinary tags remain editable.

Extend `FolioJournalDraft.test.tsx` or the nearest full Folio harness to assert:

- resolved JOURNAL passes `journal` as a derived tag even when `editor.tags` is empty;
- persisted `editor.tags = ["journal", "daily"]` renders one journal chip and `daily` as editable;
- the journal-only filter calls `editor.setTags(["daily"])` once so autosave removes the legacy persisted value; and
- a NOTE with `tags = ["journal"]` leaves it editable and does not call the filter.

- [ ] **Step 6: Run the integration tests and verify red**

Run:

```bash
bun run test ui/src/editor/__tests__/PageEditorHeader.test.tsx ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx
```

Expected: FAIL because `derivedTags` is not wired and Folio does not filter legacy journal metadata.

- [ ] **Step 7: Wire derivation and legacy cleanup**

Add `derivedTags` to `PageEditorHeader`. In `Folio`, compute:

```ts
const isJournal = kind === "JOURNAL";
const editableTags = isJournal
  ? editor.tags.filter((tag) => tag.toLowerCase() !== "journal")
  : editor.tags;
```

Pass `editableTags`, `editor.setTags`, and `derivedTags={isJournal ? ["journal"] : []}`. Add a guarded effect that, after a JOURNAL page has loaded, calls `editor.setTags(editableTags)` only when the persisted array contained `journal`; dependencies must settle after that one update and must not schedule a loop.

- [ ] **Step 8: Verify journal-tag green**

Run:

```bash
bun run test ui/src/components/ui/__tests__/tag-input.test.tsx ui/src/editor/__tests__/PageEditorHeader.test.tsx ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit the independent change**

```bash
git add ui/src/components/ui/tag-input.tsx ui/src/components/ui/__tests__/tag-input.test.tsx ui/src/editor/PageEditorHeader.tsx ui/src/editor/__tests__/PageEditorHeader.test.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx
git commit -m "fix(ui): derive immutable journal tags"
```

---

### Task 6: Integrated review, gates, and smoke tests

**Files:**
- Modify only files required to correct evidence-backed review findings.
- Do not change the approved scope or add unrelated cleanup.

**Interfaces:**
- Consumes: the five committed task deliverables.
- Produces: a review-clean, fully verified feature branch ready to merge.

- [ ] **Step 1: Review each task against its acceptance criteria**

Run a two-stage review for every task commit: first specification compliance, then code quality/security. Reject source-text tests, timing workarounds, duplicated editor policies, lossy archive paths, symlink following, and persisted derived tags.

- [ ] **Step 2: Run all verification gates**

From `ui/`:

```bash
bun run typecheck
bun run lint
bun run test
```

From the repository root after `ui/dist` exists:

```bash
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: every command exits 0. Existing route-generation and jsdom `scrollTo` notices may appear if unchanged from baseline; new warnings are failures.

- [ ] **Step 3: Run the UI smoke test**

Launch the application with a disposable or configured test vault. In a real browser:

1. inspect Document metadata at default and minimum rail widths;
2. type comma after a Markdown link and confirm the comma is outside the link;
3. select one body character, type `xy`, confirm both characters remain and the caret advances;
4. open a JOURNAL page, confirm the `journal` chip has no removal affordance, and edit an ordinary tag.

Record the exercised URL/page and observed results.

- [ ] **Step 4: Run the CLI smoke test**

Build `clep`, create a disposable configured vault containing a page, attachment, `.clepsydra/config.toml`, and `.clepsydra/cache.db`, then run:

```bash
clep backup --destination <disposable-backup-directory>
tar -tf <reported-archive>
```

Confirm the reported archive exists, includes the page/attachment/config, excludes the cache and current output files, and exits 0.

- [ ] **Step 5: Commit review corrections if any**

Stage only evidence-backed corrections and commit them with a focused `fix:` message. If review requires no changes, do not create an empty commit.

- [ ] **Step 6: Merge and update the vault source note**

Merge `feature/quick-wins` into `develop` without touching the pre-existing unstaged files. After the merged application passes the required gates, change only the five implemented source-page checkboxes from `[ ]` to `[x]`; leave all larger feature items open.
