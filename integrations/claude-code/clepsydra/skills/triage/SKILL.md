---
name: triage
description: Use when asked to "/triage", or to triage a vault page or a journal date range into Tasks — turns each item of the source into a TSK and records the pass on the project's triage index.
---

# Triaging a source into Tasks

Convert the items in a source into Tasks and record the pass on the project's
triage index. Vocabulary and tool rules come from the vault skill.

## Inputs

- `<source page>` — a page title, path, or wikilink; or
- `<YYYY-MM-DD..YYYY-MM-DD>` — a range of journal pages.

Read the source with `vault_get_page` (journals: one page per date in the
range, via `vault_search`/`vault_list_pages`). The journals are the user's
own: read them, never write to them.

## Steps

1. **Resolve project and hub.** Slug from the plugin's `projectMap` option,
   else the board project named like the repo. Hub =
   `vault_search "kind:project project:<slug>"` (with two matches, the one
   with `board = true`).
2. **Find the index.** The hub's `triage_index` is a wikilink string to the
   index page. Unset: ask the user for the index page and stop until it is
   given. Read the index with `vault_get_page`.
3. **List the items.** One entry per actionable item in the source. Check
   `vault_board` and the index first; an item that already has a TSK is
   skipped and reported.
4. **Create the Tasks.** One `vault_task_create` per item: `project` = slug,
   tags include `ai-generated`, `link` = the source page. For a journal
   source, `link` = the index page, never the journal. Group items into one
   Task only when they share one delivery surface (the same file, screen, or
   endpoint changes); every other item gets its own Task.
5. **Place on the board.** P1s and quick wins go to Ready (`TRIAGE`), a
   handful at most. Everything else stays Inbox (`INTAKE`). Set the status
   at creation or with `vault_task_update`.
6. **Record on the index.** Insert a `## Triage — <YYYY-MM-DD>` section
   (today's date) directly above the previous `## Triage — …` section, using
   `vault_edit_page` with that previous heading as `old_string`. No previous
   section: `vault_append_page`. Under it, mirror each item into its
   `Bugfixes`, `Improvements`, or `Features` list as
   `- <note> — [[Title]] (TSK-…)`, where `Title` is the Task's title.
7. **Report** a table: Task code, title, status, list.

## Rules

- Task codes come from the server's responses; copy them exactly.
- Source pages stay unedited.
