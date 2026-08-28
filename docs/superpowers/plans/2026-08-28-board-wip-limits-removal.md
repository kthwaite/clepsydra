# Drop the kanban WIP limits; even column headers (TSK-0116)

Branch `feature/board-wip-limits` in `.worktrees/board-limits`, off develop 06d4a845.

## Decisions (2026-08-28, Kit)

- **The WIP limits go.** They were hard-coded (`COLUMNS` in `src/api/board/mod.rs`: TRIAGE 6,
  FIELD 4, REVIEW 4, 0 elsewhere), never enforced on a status change, and never explained in the
  UI. Nothing replaces them.
- **`wip` leaves the API.** `BoardColumn` loses the field; the OpenAPI `BoardColumn` schema and
  `ui/src/api/schema.d.ts` follow; the MCP `vault_board` description and `mcp.mdx` stop saying
  "with WIP limits". Any client that read `wip` treated it as advisory only.
- **Header = label · sub · + · "N tasks" pill, one fixed-height row.** The pill never wraps
  (`whitespace-nowrap shrink-0`); the sub-label is the only thing that gives way (it already
  truncates). The 2px WIP fill bar and its transparent spacer go, so every column header is
  identical in height at every column width.

## Task A — server + schema (subagent)

Files: `src/api/board/mod.rs`, `src/api/board/read.rs`, `src/mcp/server.rs`,
`tests/api_board_test.rs`, `ui/src/docs/content/mcp.mdx`, `ui/src/api/schema.d.ts`.

TDD:
1. RED: `tests/api_board_test.rs` — the columns test (~218–222) asserts `columns[i].get("wip")`
   is `None` for every column (replace the two `wip` equality asserts). Any MCP contract test
   that pins the `vault_board` description must stop expecting "WIP".
2. GREEN: `COLUMNS` becomes `&[(&str, &str, &str)]`; `BoardColumn` drops `wip`; `read.rs`
   destructures three fields. `vault_board` description: "…Done (SEALED). Returns Tasks with TSK
   codes…" (delete "with WIP limits"). `mcp.mdx` row for `vault_board`: drop "with WIP limits".
   Grep `src/ tests/ .claude/ ui/src/docs` for `wip`/`WIP` afterwards — only the unrelated
   `tests/vault_path_test.rs` "drafts/wip.md" may remain.
3. Regenerate `schema.d.ts`: `cargo build`; start the worktree binary with cwd on the scratch
   config (`$SCRATCH/regen/config.toml`, port 3001, empty vault); from the worktree's `ui/`:
   `bunx openapi-typescript http://localhost:3001/api/openapi.json -o src/api/schema.d.ts`; stop
   the server. The diff must be exactly the `wip: number;` line (plus nothing else).
4. Gates: `cargo test --test api_board_test`, `cargo test` (lib + mcp tests at least; full if
   time allows), `cargo clippy --all-targets -- -D warnings`, `rustfmt --edition 2024 --check`
   on touched files.

## Task B — UI (same subagent, after A)

Files: `ui/src/components/tasking/KanbanView.tsx`, `__tests__/KanbanView.test.tsx`,
`__tests__/fixtures.ts`, `__tests__/TaskingScreen.test.tsx`.

TDD:
1. RED: replace the "WIP count and over-capacity" describe with "column header": (a) the count
   pill reads "2 tasks" / "1 task" with no "limit" text for any column; (b) the pill element has
   `whitespace-nowrap` and `shrink-0` classes; (c) no fill bar — nothing with `data-testid`
   `kb-wip-*` and no element styled `width: …%` under the header (simplest: the header's next
   sibling is the column body, `data-testid="kb-body-<id>"`); (d) every column header carries
   the same fixed height class (`h-[36px]` or whatever is chosen — assert equality of
   `className` across the five `kb-head-<id>` elements). Add `data-testid="kb-head-<id>"` and
   `kb-body-<id>` if missing.
2. GREEN: delete `over`/`fill`, the ` · limit` suffix, the hot styling branch (pill is always
   `--ink-2`/`--rule`), the fill bar + spacer. Header: `sticky top-0 z-[2] flex h-[36px]
   items-center gap-[8px] …` with the pill `ml-auto shrink-0 whitespace-nowrap`. Fixtures drop
   `wip`; TaskingScreen fixture line ~749 drops `wip: 0`.
3. Gates from `ui/`: `bun run typecheck`; `bunx biome check` on touched files only; `bun run
   test src/components/tasking`; full `bun run test` (the 2 `Sheaf.test.tsx` failures are
   pre-existing from another session — leave them).

## Task C — close-out (main session)

Review diff; gates; commit ("feat(board): drop WIP limits; even kanban column headers
TSK-0116"); merge `--no-ff` into develop with the branch verified inline; remove the worktree;
`cd ui && bun run build`, `cargo install --path /Users/kit/Source/_p.pkm/clepsydra`; seal
TSK-0116 with a note (the task's original direction — legible limits — was superseded by the
decision to remove them); mirror in Stray Thoughts; memory (`project_tasking_board.md`,
`project_dogfooding_pm.md` triage convention no longer cites a WIP limit).
