# Journal Time Heading — TDD Implementation Plan

## Approved behavior

- Dedicated atomic, non-editable Slate void block with semantic H2 / `<time>` rendering.
- Frozen browser-local `HH:mm`, persisted as clean Markdown `## HH:mm`.
- Exact H2 `HH:mm` values deserialize as time headings on every folio.
- Slash command **Time Heading** and editor shortcut **Mod+Shift+Enter**.
- Empty paragraphs are replaced; otherwise insert after the containing top-level block; always focus a fresh paragraph below.
- Keyboard deletion selects an adjacent time heading on the first Backspace/Delete and removes it on the second; an explicit gutter control deletes it wholesale. Undo restores changes.

## TDD tasks

1. Add failing schema and Markdown conversion tests for factory shape, void classification, strict time-heading recognition, malformed/unmarked headings, serialization, and round-trip.
2. Implement `journal-time` schema element, descriptor, semantic accessible renderer, registry/type integration, and conversion branches.
3. Add failing transform tests for local time formatting, empty-block replacement, insertion after content/nested content, selection placement, and undo batching.
4. Implement one shared insertion transform consumed by slash and shortcut paths.
5. Add failing interaction tests for slash discovery/dispatch, shortcut registration, and two-stage atomic deletion.
6. Implement slash command, Mod+Shift+Enter registry/handler, adjacent/select deletion behavior, and accessible delete control.
7. Review accessibility, Slate void DOM invariants, copy/round-trip behavior, and regression coverage.
8. Run frontend format, typecheck, lint, tests, and build; then repository backend fmt, clippy, and tests. Commit and merge into `develop` after review.
