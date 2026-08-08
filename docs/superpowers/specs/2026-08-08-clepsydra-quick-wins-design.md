# Clepsydra Quick Wins Design

**Date:** 2026-08-08
**Status:** Approved

## Context

The vault page **Clepsydra: Stray Thoughts** records several defects and feature ideas. This batch implements the five bounded items with the clearest user-visible value and smallest architectural footprint:

1. align folio metadata labels and values;
2. prevent inline links and text marks from absorbing trailing punctuation;
3. make Slate replace a one-character selection once and advance the caret;
4. add a local vault backup command; and
5. show `journal` as a derived, non-removable tag on journal pages.

The changes must reuse the existing Folio, Slate schema/plugin, tag-input, Clap, settings, and vault-resolution patterns. They must not introduce the larger computed-tag or remote-backup systems implied by the source note.

## Goals

- Correct each named behavior at its source rather than layering UI-only exceptions over inconsistent state.
- Keep the five changes independently testable and reviewable.
- Preserve existing note serialization, metadata editing, vault lookup, and CLI behavior.
- Provide end-to-end evidence through browser and CLI smoke tests in addition to automated verification.

## Non-goals

- Computed-tag indexing, search, filtering, or API schema changes.
- General tag permissions beyond the derived `journal` chip.
- S3, Restic, compression, scheduling, retention, incremental backups, or a restore command.
- A general rich-text punctuation grammar or automatic typography system.
- Unrelated Folio, editor, or CLI refactoring.

## Design

### 1. Folio metadata alignment

`Folio.tsx` already renders every metadata row through the shared `KV` helper. The fix belongs there, not on `KindSelect`, `ProjectCombo`, or the protection button.

The `KV` row and value wrapper will vertically center their contents while retaining the existing 64px label column, gap, typography, wrapping, and rail resize behavior. This makes `Kind`, `Project`, and `Protection` align consistently and also corrects other rows whose value is taller than their label.

**Acceptance criteria**

- Labels are vertically centered against text, select, combo, and button values.
- Long paths still wrap.
- The left rail remains usable at its configured minimum and default widths.

### 2. Inline punctuation boundary

The editor represents Markdown links and formatted text structurally in Slate. A comma typed at the right boundary of a completed link or active text mark must be inserted outside that inline context. Typing within the link remains link text; typing a normal letter at the right boundary continues the link or mark, because that may be intentional.

A single editor-level boundary rule will detect:

- a collapsed selection at the right edge of a non-void inline link; or
- active text marks inherited at the right edge of a marked leaf;

and punctuation input. It will move or split the insertion context as required, clear inherited text marks for that insertion, and insert the punctuation as plain text. The implementation must use structural Slate operations and must not special-case only commas or manipulate serialized Markdown.

The punctuation set will cover common sentence-closing characters: comma, period, semicolon, colon, exclamation mark, and question mark. Brackets and quotes are excluded because their desired nesting depends on prose context.

**Acceptance criteria**

- Typing `,` after a completed Markdown link serializes as `[label](url),`.
- The comma is not rendered as part of the link.
- Typing punctuation inside a link remains inside it.
- Typing a letter at the link boundary preserves existing continuation behavior.
- The same plain-text boundary behavior applies to bold and italic text.

### 3. Single-character selection replacement

The defect occurs in the Slate page body. With an expanded selection covering one character, the first printable input must delete the selected range, insert the input once, and collapse the caret immediately after the new character. A second printable input must append at that caret instead of replacing the same span again.

Implementation begins with a deterministic reproduction through the editor's real input path. The correction will be made at the shared Slate transform or input boundary revealed by that reproduction. Per-key handlers and timing delays are prohibited because they would hide the selection-state defect rather than restore the editor invariant.

**Acceptance criteria**

- Replacing one selected character with `x` produces one `x` and a collapsed caret after it.
- Immediately typing `y` produces `xy` at that location.
- The behavior holds for punctuation as well as letters.
- Undo restores the pre-replacement content through the existing history integration.

### 4. Local backup command

Add this CLI surface:

```text
clepsydra backup --destination <directory>
```

The command uses the existing application settings lookup and `resolve_vault_root` path. It creates the destination directory when absent, then writes a plain tar archive named:

```text
clepsydra-backup-<UTC timestamp>.tar
```

Creation uses a temporary sibling file followed by an atomic rename. Archive paths are relative to the vault root. Symlinks are stored as symlinks and are not followed.

The archive includes normal vault content and `.clepsydra` configuration. It excludes:

- `.clepsydra/cache.db`;
- the final output archive when the destination lies inside the vault; and
- the temporary archive used during creation.

The command prints only the resulting archive path to stdout on success. On failure it returns non-zero, removes its temporary file, and leaves no misleading final archive. A destination that resolves to an existing non-directory is an error.

A focused `vault::backup` module owns archive traversal and creation. The Clap enum and dispatch arm remain thin.

**Consistency limitation**

This is a file-level backup, not a transactional filesystem snapshot. Files modified concurrently may reflect different instants. Excluding the disposable cache avoids embedding a live SQLite index; the Markdown and attachment files remain the source of truth.

**Acceptance criteria**

- A configured vault can be archived to an existing or newly created destination directory.
- The archive contains pages, attachments, and `.clepsydra/config.toml`.
- The archive excludes `.clepsydra/cache.db` and its own output files.
- An inside-vault destination does not recursively archive prior or current output files matching the exact current output paths; unrelated older backups remain ordinary vault content unless they are the selected output file.
- Failure removes the temporary file and reports a non-zero exit.

## 5. Derived journal tag

For pages whose resolved kind is `JOURNAL`, the editor header shows a `journal` chip derived from the kind. The chip is visually consistent with tags but has no removal action and is not included in the editable tag array.

`TagInput` will receive an explicit read-only/derived-values input rather than inferring tag names itself. This keeps the generic component reusable and makes ownership clear. `Folio` derives the immutable value from the already resolved page kind.

If a journal page already contains a persisted `journal` tag, the editable values filter it out and the next metadata save omits it. Non-journal pages continue treating a user-authored `journal` tag as ordinary metadata; this batch does not reserve the word globally.

Search and tag-index responses continue to reflect persisted tags only. Making derived tags queryable belongs to the later computed-tag feature.

**Acceptance criteria**

- Every resolved JOURNAL page displays a `journal` chip even when frontmatter lacks the tag.
- The chip cannot be removed by pointer or keyboard.
- Adding and removing ordinary tags continues to work.
- Saving a JOURNAL page does not write `journal` into frontmatter and removes a legacy persisted copy on the next metadata save.
- A NOTE page with an ordinary `journal` tag remains editable.

## Error handling

- Editor boundary helpers return without mutation when selection or structure does not match their contract, preserving Slate defaults.
- Backup path and I/O errors retain their source context and propagate to the CLI's existing error reporter.
- Temporary backup artifacts are cleaned up on every handled failure path.
- Derived tags never mutate metadata directly; ordinary tag changes continue through the existing autosave pipeline.

## Testing and verification

### Automated behavior tests

- `Folio`/`KV`: shared row alignment classes and narrow-rail rendering behavior where observable.
- Slate editor: link and marked-text punctuation boundaries, inside-link punctuation, normal-letter continuation, one-character replacement, repeated typing, punctuation replacement, and undo.
- `TagInput` and `PageEditorHeader`/`Folio`: immutable derived chip rendering, keyboard/pointer non-removability, ordinary edits, journal derivation, and legacy persisted-tag filtering.
- Rust backup module and CLI dispatch: archive contents, exclusions, symlink behavior, missing destination creation, invalid destination failure, cleanup, and stdout path.

### Verification gates

- UI typecheck: `bun run typecheck`
- UI lint: `bun run lint`
- UI suite: `bun run test`
- Rust type/build check: `cargo check`
- Rust lint: `cargo clippy --all-targets --all-features -- -D warnings`
- Rust suite: `cargo test`

### Smoke tests

- Launch the application and use a real browser to inspect Folio metadata, type punctuation after a link, replace a selected character twice, and inspect a JOURNAL page's derived tag.
- Initialize or use a disposable configured vault, invoke `clepsydra backup`, list the resulting tar contents, and verify included and excluded paths.

## Delivery

Each quick win is implemented as a separate TDD task in an isolated feature worktree. Independent tasks may run concurrently, but editor tasks share an explicit contract and receive review before integration. After all verification gates and smoke tests pass, the feature branch is committed and merged into `develop`. Only then are the five source-page checkboxes marked complete in the vault.
