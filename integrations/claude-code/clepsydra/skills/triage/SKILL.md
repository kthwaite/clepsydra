---
name: triage
description: Use when asked to "/triage", or to triage a vault page or journal date range into Tasks and Epics — creates executable Tasks, groups multi-delivery outcomes under Epics, and records the pass on the project's triage index.
---

# Triaging a source into Tasks

Convert the items in a source into Tasks and record the pass on the project's
triage index. Vocabulary and tool rules come from the vault skill.

## Inputs

- `<source page>` — a page title, path, or wikilink; or
- `<YYYY-MM-DD..YYYY-MM-DD>` — a range of journal pages.

Read a source page with `vault_get_page`. For a journal range, list the
journals with `vault_list_pages` and `kind: "JOURNAL"`: the list is ordered
by path, and a journal's path is
`journals/<yyyymmdd>.<YYYY-MM-DD>.<shortid>.md`. Keep the rows whose
`YYYY-MM-DD` falls inside the range (both ends included). Page with
`offset` until a row's date passes the range end or the rows run out. Then
`vault_get_page` each kept path. The journals are the user's own: read
them, never write to them.

## Steps

1. **Resolve project and hub.** Slug from the plugin's `projectMap` option,
   else the board project named like the repo. Hub = the `vault_board`
   (`project: <slug>`) `operations[]` row whose `project` is the slug; its
   `path` is the hub page. No row: tell the user and stop.
2. **Find the index.** The hub's `triage_index` is a wikilink string to the
   index page. Unset: ask the user for the index page and stop until it is
   given. Read the index with `vault_get_page`.
3. **List the items.** One entry per actionable item in the source. Check
   `vault_board` and the index first; an item that already has a TSK is
   skipped and reported.
4. **Create the Tasks.** One executable Task per delivery surface (file,
   screen, or endpoint change), with `project` = slug, tags including
   `ai-generated`, and `link` = source page. For a journal source, use the
   index page as `link`, never the journal. For one outcome spanning multiple
   deliveries, follow the vault skill's **Epics and executable children**:
   create or reuse the Epic first, then set each child's `parent_epic` to its
   returned code. Preserve existing child task types and attach existing Tasks
   instead of duplicating them. The Epic records outcome-level acceptance;
   each child records its own deliverable.
5. **Place on the board.** Move a handful of executable P1s and quick wins
   to Ready (`TRIAGE`); the rest stay Inbox (`INTAKE`). Schedule and estimate
   children individually. Parent status remains an explicit planning decision,
   not a consequence of starting, merging, or completing a child.
6. **Mirror into the standing lists.** The index has standing top-level
   `Bugfixes`, `Improvements`, and `Features` lists. Add each item to its
   list as `- <note> — [[Title]] (TSK-…)`, where `Title` is the Task's
   title: one `vault_append_page` per list with `heading` set to that
   list's heading. A list the index lacks: tell the user, and leave that
   item out of the index.
7. **Record the pass.** Insert a `## Triage — <YYYY-MM-DD>` section (today's
   date) naming the source and the Task codes, directly above the newest
   previous `## Triage — …` section, with `vault_edit_page`:
   - `old_string` = the previous section's heading line, exactly as read;
   - `new_string` = the new section, a blank line, then that same heading
     line.

   No previous `## Triage — …` section: `vault_append_page` the new section
   at the end of the page.

   Example: the index holds `## Triage — 2026-10-14`; today is 2026-10-21.

   ```json
   {
     "path": "<index path>",
     "old_string": "## Triage — 2026-10-14",
     "new_string": "## Triage — 2026-10-21\n\nSource: [[Stray Thoughts]]. Tasks: TSK-brave-finch-7q3zd, TSK-calm-owl-bbbbb.\n\n## Triage — 2026-10-14"
   }
   ```
8. **Report** a table: Task code, title, type, parent Epic, status, list.

## Rules

- Task codes come from the server's responses; copy them exactly.
- Source pages stay unedited.
