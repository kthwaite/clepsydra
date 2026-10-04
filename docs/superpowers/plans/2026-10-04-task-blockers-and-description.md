# Task Blockers + Card Description — TDD plan (2026-10-04)

Sequenced after `feature/task-type` merges. Two branches off develop, in order:
`feature/task-blockers`, then `feature/task-description`.

---

## A. Task Blockers (`feature/task-blockers`)

### Rulings (user, 2026-10-04)

- Store `blocked_by` on the blocked Task only. `blocks` is derived (the inverse), never persisted.
- Values are wikilinks to Task codes: `blocked_by: ["[[TSK-brave-finch-7q3zd]]"]` (task filenames are their codes, so these index as property ref links → backlinks + rename repair).
- A Task reads **Blocked** when any blocker is not Done (`SEALED`) **or** `hold` is set. `hold` stays as the free-text manual reason. A sealed blocker stops blocking automatically.
- Reject cycles (400). Warn (not refuse) when moving a Task with open blockers to In Progress.
- Card chips for both directions; edit panel picker for both directions; MCP params; board response carries both lists.

### Implementer choices

- PATCH/CREATE `blocked_by: string[]` replaces the whole list (like `tags`); `[]` or `null` clears; absent keeps.
- Each entry may be a code, a unique code prefix, or `[[CODE]]`; resolved via `code::resolve_prefix` over Task code stems; stored canonical as `[[CODE]]`, de-duplicated, order kept.
- 400 on: unknown/ambiguous code, self-reference, cycle (DFS over current `blocked_by` graph with the proposed edges).
- Board DTO: `blocked_by: Vec<String>` (codes), `blocks: Vec<String>` (codes, derived), `blocked: bool` (derived as above). Dangling blocker (deleted/rubbished page) is listed but does not count as open.
- Editing "blocks" in the UI = PATCH the other Task's `blocked_by` (add/remove this code). No server endpoint for the inverse.
- Glossary: CONTEXT.md gains **Blocker** ("a Task another Task waits on; recorded on the waiting Task as blocked_by") and Task Fields gains blocked_by; Blocked definition updated.

### Task A1 — backend

Tests first:
- task_patch unit: resolve prefix → `[[CODE]]`; dedupe; self-ref error; unknown/ambiguous error; cycle error (A blocked_by B, then B blocked_by A); clear via `[]`/null; meta untouched on error.
- read: `blocks` inverse computed; `blocked` true with open blocker, false once blocker SEALED; `hold` alone still blocked; dangling blocker not open.
- api_board_test integration for POST + PATCH + GET round trip, cycle 400.
- MCP: `blocked_by` on create/update (update: absent keeps, null/[] clears, list sets); tool descriptions updated.
- BoardLookups gains task code stems + current blocked_by graph (one index snapshot).

Then: regenerate schema.d.ts; docs (`mcp.mdx`, `tasks-agenda-journals-and-board.mdx`); CONTEXT.md.

### Task A2 — frontend

Tests first:
- TaskCard: `blocked by TSK-x` chip(s) (code links open the blocker's dossier/edit), `blocks N` chip; Blocked stamp driven by `t.blocked` not `t.hold`.
- FilterBar "Blocked" flag uses `t.blocked`.
- TaskEditPanel: "Blocked by" and "Blocks" task pickers (combobox over board tasks, excludes self); add/remove PATCHes the right task; server 400 (cycle) surfaces as an inline error.
- KanbanView/InlineEditPopover status change to FIELD with open blockers → warning dialog/toast with Continue / Cancel (non-blocking). Use existing modal/dialog primitives (no browser `confirm`).
- MCP n/a.

---

## B. Card Description (`feature/task-description`)

### Rulings (user, 2026-10-04)

- Card shows the page body rendered as markdown (formatting + links), clamped ~4 lines with a fade. Replaces the plain 2-line `body_excerpt` on TaskCard.

### Implementer choices

- Backend adds `description: Option<String>` to BoardTask: the body markdown with the checklist items (`- [ ]`/`- [x]` lines that feed `checks`) removed, trimmed, capped at ~1500 chars at a block boundary. `body_excerpt` stays (other consumers / Backlog rows).
- UI renders with the existing `ui/src/components/MarkdownRenderer.tsx` (react-markdown) in a compact variant: no headings larger than body text, images hidden, wikilinks clickable via existing `onOpenPage`, clicks on links `stopPropagation` so the card doesn't open/drag.
- Clamp via CSS `line-clamp-4` + mask fade; Stone & Lamp tokens.

### Task B1 — backend + frontend (one task; small)

Tests first:
- Rust: description strips checklist lines, keeps prose/lists/links; caps length; None for empty body.
- UI: TaskCard renders `**bold**` as `<strong>` and a wikilink as a link; link click calls onOpenPage and does not trigger card onClick; empty description renders nothing.

Gates for each branch: cargo fmt/clippy/test; ui typecheck/lint/test. Merge each to develop `--no-ff` and remove its worktree.
