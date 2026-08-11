---
name: onboard-project
description: Use when adding a project or repo to clepsydra as a PM/documentation target — "onboard X", "add X to clepsydra", "set up X for dogfooding", or when a repo should start using the vault as its system of record.
---

# Onboarding a project into clepsydra

Make the vault the system of record for a repo's project state. The recipe is
three artifacts plus one conditional migration — nothing else. Do not
reconstruct conventions from previously onboarded repos; this file is the
convention. Requires the vault MCP (`clep serve` running); page conventions
(search-before-create, `ai-generated`, wikilinks) come from the vault skill.

## Recipe

**1. Repo: `.mcp.json`** at the repo root, exactly:

```json
{
  "mcpServers": {
    "clepsydra": {
      "command": "clep",
      "args": ["mcp"]
    }
  }
}
```

**2. Repo: guidance section** appended to the repo's agent-guidance file
(`CLAUDE.md`, or `AGENTS.md` where that is the file that exists — do not add
symlinks or new files):

```markdown
## Project management: clepsydra vault

<Name>'s project state — status, backlog, decisions, session logs — lives in
the clepsydra vault, reached via the `clepsydra` MCP server (`vault_*` tools;
requires `clep serve` running locally). The vault is the system of record for
project state; this repo keeps only code-adjacent/contractual docs.

- **Session start:** read the hub — search the vault for the "<Name>" project
  page — and check open tasks under project `<slug>` (`vault_board`).
- **Durable output:** decisions and status notes go to vault pages under
  project `<slug>`, wikilinked to the hub; update the hub's Status/Threads
  sections when they change.
- **Session end:** log what changed and what's next with `vault_journal_capture`.
```

Name the repo's contractual artifacts (spec, design corpus, plan dirs) in the
first paragraph when they exist.

**3. Vault: hub page.** `vault_search` for the project name first; extend an
existing hub rather than duplicating. Otherwise `vault_create_page` with
title = project name, kind `PROJECT`, project = slug, tags `["ai-generated"]`
plus existing vocabulary only (check `vault_tags`; onboarding never mints new
tags). Body shape, in order:

- Intro: what the project is, repo path, what stays in-repo and why.
- The sentence: "Claude sessions in the repo read this page at session start
  and journal-capture at session end."
- `## Status` — dated bullets, including "Clepsydra adopted as the
  PM/documentation layer on <date> (dogfooding)."
- `## Threads` — open work and next steps.
- `## Repo pointers (stay in repo)` — the contractual docs.

**4. Backlog migration — only if the repo tracks work in files** (FIXME.md,
ISSUES.md, TODO/BACKLOG-style documents). Find the *authoritative* tracker
first (stale ones often point to a successor). One `vault_task_create` per
open item (project = slug, tags include `ai-generated`; the board assigns
TSK codes), an index NOTE named "<Name> Backlog" wikilinking the tasks, then
demote the tracker files to short pointer stubs referencing the vault (their
history stays in git). No tracker files → open work goes in hub Threads, no
tasks are created.

**5. Close out:** one `vault_journal_capture` bullet wikilinking [[<Name>]].
Leave all repo changes uncommitted unless asked to commit.

## Don'ts

- No hand-constructed vault paths, no new tags, no folders/bases/symlinks or
  other extra steps.
- No unverified claims in the hub (vault location, dates, status) — state only
  what you checked.
