---
name: decide
description: Use when asked to "/decide", "record a decision", or "log this decision" — appends one dated decision entry to the project hub's Decisions section in the clepsydra vault.
---

# Recording a decision

A decision is one line on the project hub, under `## Decisions`. Vocabulary
and tool rules come from the vault skill.

## Steps

1. **Resolve the project slug.** The plugin's `projectMap` option maps this
   repo to a slug; without a mapping, use the board project named like the
   repo (`vault_board`). No slug resolves: ask the user, then stop.
2. **Find the hub.** `vault_board` with `project: <slug>`: the hub is the
   `operations[]` row whose `project` is the slug, and its `path` is the
   hub page. The board lists one row per slug, so this is the hub the
   plugin uses. No row: tell the user and stop (`onboard-project` creates
   one).
3. **Compose one entry** from the user's words and the conversation. The
   decision and the reason must both be stated; ask for the missing one.
   Reference is a `[[TSK-…]]` code (the active Task, or one the user names)
   or a commit sha; omit the parentheses when neither exists.

   ```markdown
   - <YYYY-MM-DD> — <decision>. Why: <reason>. ([[TSK-…]] or <sha>)
   ```

   Use today's date.
4. **Append.** `vault_get_page` the hub, then `vault_append_page` with
   `heading: "Decisions"` and the entry. The hub has no `## Decisions`
   heading: append `## Decisions` plus the entry at the end of the page
   instead.
5. **Confirm** with the entry text and the hub title.

## Rules

- One entry per call; earlier entries stay exactly as they are.
- A changed decision gets a new entry that names the one it supersedes.
