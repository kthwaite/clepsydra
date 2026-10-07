# Architecture deepening batch (2026-10-07)

Source: `/improve-codebase-architecture` run on develop @ a79487bf. Nine candidates, all in scope.
Vocabulary: module, interface, seam, adapter, depth, leverage, locality (codebase-design skill).

## Rulings (made without user input; user said "all, let's smash these out")

- R1. **Refactors only.** No user-visible behaviour change except the fixes named below. Error message strings stay as they are today, per handler.
- R2. **Named fixes that are allowed:** (a) Tasking `type` facet persists in the URL; (b) by-id handlers without a moved-page retry gain it (properties ×2, patch_task, patch_cycle, academic); (c) `update_page_at_path` takes time from `state.clock`.
- R3. **Gazetteer store mode is deleted.** `filters` becomes required. Tests that used the store switch to the prop.
- R4. **Watcher→reconcile loop moves to `clep-mutate`.** Callbacks (feed-manifest hook, broadcast) are injected. `clep-api` keeps spawning.
- R5. **Tests:** each new module gets interface-level unit tests written first (red → green). Existing integration and full-render tests must stay green. Do not delete existing tests unless they test removed code (e.g. Gazetteer store mode); move their assertions to the new module where possible.
- R6. One branch per track, off develop. Merge to develop in the order listed under Merge order.

## Tracks

Tracks run in parallel in separate worktrees under `.worktrees/`. Tasks inside a track run in sequence.

### Track A: backend board and pages (`refactor/page-identity`)

**A1 Page identity (#3).**
- Add a public `VaultIndex::page_path_by_id(&self, id: &str, kind: Option<Kind>) -> rusqlite::Result<Option<String>>` (or the index's existing error type) in `clep-index`.
- Replace the 3 private copies in `index.rs`.
- Add one retry combinator in `clep-api` (e.g. `api/page_identity.rs`): `resolve_stable_by_id(state, id, kind, not_found: impl Fn() -> ApiError, attempt)`. It owns `BY_ID_PATH_ATTEMPTS`, `observe_page_id_lookup`, the path lock, the re-query and the compare, and the "file vanished, path moved, retry" branch.
- Move `get_page_by_id`, `update_page_by_id`, `transition_page_by_id`, properties.rs ×2, `patch_task`, `patch_cycle`, academic.rs:1723 and page_export/snapshot.rs:429 onto it. Use the plain query where a handler does not need the lock.
- TDD: index unit tests for `page_path_by_id` (found, missing, kind filter mismatch). Combinator tests with a real index: stable path, moved between the two queries (retries), still missing → `not_found()`.

**A2 Cycle Patch (#5).**
- Add `board/cycle_patch.rs` with a pure `plan_cycle_patch(meta, body, patch, &BoardLookups) -> Result<CyclePlan, CyclePatchError>`. Model it on `task_patch.rs`.
- Move cycle code resolution into `BoardLookups`. Delete `ensure_cycle_exists`. Keep one copy of the "unknown cycle" and "ambiguous cycle prefix" strings, shared by `TaskPatchError` and `CyclePatchError`.
- `patch_cycle` becomes resolve (A1) → read → plan → execute → DTO.
- TDD: unit tests for state transitions, carry_to validation (unknown, ambiguous, self, closed), and the carry-over task set.

**A3 Page update planner (#8).**
- Add a pure `plan_page_update(page, body, now) -> Result<UpdatePageCommand, ApiError>` covering uuid identity, revision, age armor and the 5 optional field merges. The handler passes `state.clock.now()`.
- Add one `stale_to_revision_conflict` helper and use it at the 5 call sites (pages.rs ×2, sync.rs:586, base_render.rs:502, feeds.rs:353).
- Fold `read_indexed_page_once` and `read_assignment_page_once` into one reader that takes a missing-file policy.
- Replace the inline `SyncNotification::IndexChanged { … }` closures with `api::mutation_notifier` where they are byte-equivalent.
- TDD: planner unit tests (each field kept / set / cleared, revision mismatch, uuid mismatch, armor rejection).

### Track B: watcher loop (`refactor/watch-loop`) (#9)

- Move `drain_change_batch`, `notifications_from_batch`, `process_sync_batch` and `reconcile_upserts` (clep-api/src/lib.rs:42–75, 385–515) into a `clep-mutate` module. Name it after what it does (e.g. `watch_reconcile`).
- `spawn_sync_watcher` stays in clep-api and calls into it with injected callbacks.
- TDD: unit tests in clep-mutate for batching and for the upsert-vs-delete notification split, driven with a temp vault and no HTTP.

### Track C: Folio (`refactor/folio-surface`) (#1 then #7)

**C1 Body-mode resolver (#1).**
- New `ui/src/components/codex/folioSurface.ts`: a pure `resolveFolioSurface(input) -> { surface, readOnly, rawAvailable, canToggleEdit, … }`. Input is kind/presentation, editor flags (loading, error, isDraft, offline, readonly, generatedChangePending, encrypted/encryption status), recipe flags, conversation mode, and the journal-today and AI-journal-today flags.
- Add a `useFolioMode(path)` hook that owns the mode state (recipe mode, conversation mode, read/edit) and resets it on path change.
- Folio.tsx lines ~406, 493–509 and 561–623 use the resolver. JSX branches switch on its result.
- TDD: a table test (`folioSurface.test.ts`) with one row per kind × mode × blocking flag, written before extraction from the current expressions.

**C2 Session hooks (#7).**
- `useFolioRestoration` (Folio.tsx:412–492, 762–917). Fold the duplicated snapshot code. No ref writes during render.
- `useRawMarkdownSession` (168–245, 499–521, 624–688). Recipe projection updates go through an `onApplied` callback.
- `useFolioTab` (331–392, 539–545, 689–733, 959). Merge the two journal-today effects.
- TDD: renderHook tests per hook with a fake editor and a real workspace store.

### Track D: filters (`refactor/filter-route`) (#2)

- Add `{ id: "type", kind: "multi" }` to the Tasking URL spec first, with a failing `routes/-tasking.test.tsx` case.
- Add a filter-route module in `ui/src/lib/filters/` that builds the navigation, parse, onChange and validateSearch wiring from one spec. Facet definitions live in one place, beside the screen, and both the URL spec and FilterBar fields come from it.
- Move tasking, rubbish, calendar, agenda, academic and gazetteer onto it. Gazetteer's hand-written parser goes away (R3).
- TDD: module unit tests (round-trip parse/merge/canonicalize for multi, flag, text and aliases), then each route's existing test stays green.

### Track E: Task Draft (`refactor/task-draft`) (#4)

- New `ui/src/components/tasking/taskDraft.ts`: `fromTask`, `toCreatePayload`, `diffToPatch`, `parseTags`, `blankToNull`, defaults. `diffToPatch` follows the server Task Patch contract (empty clears).
- New `task-fields` vocabulary module (or extend `board-constants.tsx`): `isDone`, `isInProgress`, `statusLook(status)`, `DEFAULT_STATUS` and `DEFAULT_PRIORITY`. Replace the hand-coded status literals in non-test files, including TimelineView's colour map, where the look is equivalent.
- New `usePatchQueue` hook, extracted from TaskEditPanel's `useDebounced` and lanes.
- NewTaskModal and TaskEditPanel use them.
- TDD: codec and vocabulary pure tests, and a `usePatchQueue` renderHook test with fake timers.
- **Avoid TaskingScreen.tsx filter code (Track D owns it).** Touch TaskingScreen only for status-literal swaps.

### Track F: Base table model (`refactor/base-table-model`) (#6)

- `useBaseTableController` returns a grouped `BaseTableModel` with a `status` union (`loading | missing | ready`) and a small set of groups (query, members, overrides, rowActions, window). Group names come from what the fields do.
- `BaseTableView` takes `model` plus presentation options. Add `readOnlyModel(output)` for BasePreview.
- BaseTable, EmbeddedBaseTable and BasePreview adapt to it.
- TDD: a controller renderHook test for the status union, a `readOnlyModel` unit test, and existing Bases tests stay green.

## Global constraints

- Rust: `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (or `-p` for the touched crates during iteration, full workspace before hand-back).
- UI (from `ui/`): `bun run typecheck`, `bun run lint`, `bun run test`. Scope `biome --write` to your own files.
- If a route or DTO changes, regenerate the schema offline: `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`. None should change.
- Never run `clep` without `CLEPSYDRA__VAULT__ROOT` pointing at a scratch dir.
- Stage explicit paths (`git add <paths>`). `git add .` is intercepted.
- Commit per task, conventional style `refactor(<area>): …`. No attribution lines.

## Merge order

D → E (TaskingScreen overlap) · A · B · C · F. Before each merge, run `git merge-tree --write-tree develop <branch>` and re-run the gates on the merged result.
