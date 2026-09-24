# Conflict Diff View — Plan (2026-09-24)

Branch `feature/conflict-diff`, worktree `.worktrees/conflict-diff` (off develop c88e6636).

## Goal

Resolve a Conflict Copy (ADR 0004) from the UI: side-by-side diff of the
original ("local", still at its path) and the copy ("other", written by sync),
pick per hunk, save the merged result into the original, bin the copy.

## Decisions (settled with user)

- D1 Per-hunk choice: `local` | `other` | `both` (local lines then other lines). Default `local`. No free-text editing of the result.
- D2 Side-by-side layout; stacks to one column below `md`.
- D3 Dedicated route `/conflicts/$` (splat = copy path). The list gets a "Compare" button (only when `original_exists`).
- D4 Frontmatter is diffed, minus copy-only noise. Both sides are shown in a *comparable* form:
  parse → `id` = original's id on both sides, `updated_at` = None on both sides,
  copy: `conflict_of` extra removed, trailing ` (conflict <7hex>)` title suffix removed
  → re-serialise both with `write_page_content`. Same serializer both sides ⇒ no format noise.
- D5 Resolve = write the original through `mutation_coordinator.update_page`
  (revision-guarded against the original's raw revision), then archive the copy
  to the Rubbish Bin (revision-guarded against the copy's raw revision). Not atomic:
  if binning fails after the write, return 500 whose message says the original was saved
  and the copy remains.
- D6 Server on resolve: merged text must parse (`parse_frontmatter`, else 400);
  force `id` = original id, drop `conflict_of`, `updated_at` = now.
- D7 Encrypted page on either side (`is_encrypted`) or unparseable frontmatter → 422
  "resolve by hand". Original missing → 404 (list hides Compare in that case).
- D8 Line diff on the client with the `diff` (jsdiff) package, added as a direct dependency.

## API

Axum 0.8: wildcards must be terminal, so the copy path travels as query/body, not a path segment.

- `GET /api/vault/sync/conflicts/compare?copy=<vault path>` → `ConflictCompareDto`
  `{ copy_path, original_path, original_title?, local: { text, revision }, other: { text, revision } }`
  (`text` = comparable form, D4; `revision` = `page_revision` of the raw file bytes).
  404: copy missing / copy has no `conflict_of` / original missing. 422: D7.
- `POST /api/vault/sync/conflicts/resolve` body
  `ConflictResolveRequest { copy, merged, original_revision, copy_revision }` →
  200 `ConflictResolveDto { original_path, archived: RubbishItemSummary }`.
  409 `revision_conflict` when either revision is stale. 400 unparseable merged. 422 D7.

## Tasks (TDD: failing test first, then code)

### T1 — Backend (Rust)
Files: `crates/clep-gitsync/src/conflict_copy.rs` (pure helper), `crates/clep-api/src/api/sync.rs`
(handlers + routes + DTOs), `crates/clep-api/src/api/openapi.rs` (register paths/schemas).
1. Pure `comparable_page_text(raw: &str, original_id: Uuid, is_copy: bool) -> Result<String, FrontmatterError>`
   (or similar) in conflict_copy.rs, next to `conflict_copy_content`, which it inverts.
   Unit tests: round trip `conflict_copy_content` of an unchanged page → identical comparable text
   to the original's; a body edit on one side shows only as body difference; `updated_at` differences vanish;
   an unrelated title containing "(conflict" but not the 7-hex suffix is kept.
2. Compare handler + tests (use the existing tests in sync.rs `conflicts_endpoint_*` as the fixture pattern):
   happy path, 404 non-copy, 404 missing original, 422 encrypted (fixture in clep-test-support).
3. Resolve handler + tests: happy path writes original (id kept, no `conflict_of`, merged body),
   copy is in the Rubbish Bin, conflicts list now empty; stale `original_revision` → 409 and nothing changed;
   stale `copy_revision` → 409 and original unchanged (check both revisions *before* writing);
   unparseable merged → 400. Reuse the archive path `delete_page` uses (pages.rs) — extract a shared fn
   rather than duplicating.
4. Regenerate the schema offline:
   `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.

### T2 — Pure merge model (TS)
Files: `ui/src/lib/conflictMerge.ts` + `ui/src/lib/conflictMerge.test.ts`; add `diff` to `ui/package.json` dependencies.
- `type Segment = { kind: "same"; lines: string[] } | { kind: "change"; id: number; local: string[]; other: string[] }`
- `diffSegments(local: string, other: string): Segment[]` — line-level; adjacent removed+added runs form one change hunk;
  pure insertions/deletions are hunks with one empty side.
- `type Choice = "local" | "other" | "both"`; `assembleMerge(segments, choices: ReadonlyMap<number, Choice>): string` — default `local`.
- Invariants to test: all-local ⇒ `local` byte-for-byte; all-other ⇒ `other` byte-for-byte (including trailing-newline
  presence/absence and CRLF-free inputs); identical inputs ⇒ one `same` segment and no hunks; `both` order; empty sides.

### T3 — UI (after T1+T2)
Files: `ui/src/api/index.ts` (or `ui/src/api/sync.ts` if cleaner) hooks; `ui/src/routes/conflicts_.$.tsx`
(non-nested splat, `staticData: { codexView: "conflicts" }`) + a row in `ui/src/routes/__tests__/routeViews.test.ts`;
`ui/src/components/conflicts/ConflictDiffView.tsx` + tests; `ConflictsPanel.tsx` gains "Compare".
- `useConflictCompare(copy)`, `useResolveConflict()`; on success invalidate conflicts list, sync status,
  the original's page content, page structure, rubbish (see `ui/src/api/keys.ts` helpers).
- View: header (copy path ↔ original path), counters (`n changes`), "All local" / "All other" bulk actions,
  side-by-side rows: `same` segments collapsed to 3 lines context each side with an "N unchanged lines" expander;
  each change hunk shows local (left) / other (right) with a Local / Other / Both toggle group; a "Result"
  preview (read-only, monospace) of `assembleMerge`; "Resolve" button → mutation → navigate to `/conflicts`.
  409 → inline alert "One side changed since this view loaded. Reload to compare again." with Reload.
  422 → alert explaining manual resolution, with Open buttons.
- Follow `ui/CLAUDE.md` (Vessel design tokens, RAC components from `#/components/ui`). Tests with RTL + mocked hooks.

### T4 — Docs
`ui/src/docs/content/sync.mdx`: a short "Comparing and resolving" section. `featureInventory.ts` if it lists sync features.

## Gates
`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`;
`cd ui && bun run typecheck && bun run lint && bun run test`. UI failures: diff against develop's baseline
(memory: ~917 env failures under Node 26) — only new failures count.
