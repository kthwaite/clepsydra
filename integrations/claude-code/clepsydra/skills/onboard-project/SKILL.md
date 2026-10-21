---
name: onboard-project
description: Use when adding a project or repo to clepsydra as a PM/documentation target — "onboard X", "add X to clepsydra", "set up X for dogfooding", or when a repo should start using the vault as its system of record.
---

# Onboarding a project into clepsydra

Make the vault the system of record for a repo's project state. The recipe is
three artifacts plus one conditional migration — nothing else. Do not
reconstruct conventions from previously onboarded repos; this file is the
convention. Requires the clepsydra plugin installed and `clep serve`
running; page conventions (search-before-create, `ai-generated`, wikilinks)
come from the vault skill.

## Recipe

**1. Repo: guidance pointer** appended to the repo's agent-guidance file
(`CLAUDE.md`, or `AGENTS.md` where that is the file that exists — do not add
symlinks or new files). Exactly these two lines, with the slug and hub title
filled in:

```markdown
## Project management: clepsydra vault

Project state lives in the clepsydra vault (project `<slug>`, hub [[<Hub Title>]]); the clepsydra plugin supplies the tools and skills.
```

The plugin supplies the MCP server; a repo `.mcp.json` is no longer needed. When the repo has contractual
artifacts (spec, design corpus, plan dirs), list them under the hub's
`## Repo pointers`.

**2. Vault: hub page.** `vault_search` for the project name first; extend an
existing hub rather than duplicating. Otherwise `vault_create_page` with
title = project name, kind `PROJECT`, project = slug, tags `["ai-generated"]`
plus existing vocabulary only (check `vault_tags`; onboarding never mints new
tags). Body shape, in order:

- Intro: what the project is, repo path, what stays in-repo and why.
- The sentence: "Claude sessions in the repo read this page at session start
  and log to the AI journal at session end."
- `## Status` — dated bullets, including "Clepsydra adopted as the
  PM/documentation layer on <date> (dogfooding)."
- `## Threads` — open work and next steps.
- `## Repo pointers (stay in repo)` — the contractual docs.

**3. Hub frontmatter.** Set two TOML keys on the hub page:

- `integration_branch` — a string. Ask the user which branch merges land on;
  offer the integration branch named in the repo's `CLAUDE.md` as the default.
  The plugin moves a Task to Review when Claude merges into this branch.
  Without it, merge automation is off.
- `triage_index` — optional wikilink string such as
  `"[[<Name> Backlog]]"`. Ask; omit when the user has no backlog index.

The vault tools do not write arbitrary frontmatter keys. Give the user the
exact lines to add to the hub's frontmatter, and confirm with `vault_get_page`
once they have.

**4. Backlog migration — only if the repo tracks work in files** (FIXME.md,
ISSUES.md, TODO/BACKLOG-style documents). Find the *authoritative* tracker
first (stale ones often point to a successor). One `vault_task_create` per
open item (project = slug, tags include `ai-generated`; the board assigns
TSK codes), an index NOTE named "<Name> Backlog" wikilinking the tasks, then
demote the tracker files to short pointer stubs referencing the vault (their
history stays in git). No tracker files → open work goes in hub Threads, no
tasks are created.

**5. Close out:** one `vault_ai_journal_capture` bullet wikilinking [[<Name>]].
Leave all repo changes uncommitted unless asked to commit.

## Don'ts

- No hand-constructed vault paths, no new tags, no folders/bases/symlinks or
  other extra steps.
- No unverified claims in the hub (vault location, dates, status) — state only
  what you checked.
