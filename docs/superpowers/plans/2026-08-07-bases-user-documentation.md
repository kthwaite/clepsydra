# Bases User Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a canonical practical guide for vault users who author `.base.toml` files and use Bases in Clepsydra.

**Architecture:** Add one focused guide, `docs/bases.md`, as the canonical description of the shipped authoring model. Existing setup and LSP guides receive short cross-links rather than duplicate schema reference material.

**Tech Stack:** Markdown documentation, TOML examples, Clepsydra Rust base/query models, React Bases route, Clepsydra LSP.

## Global Constraints

- Document shipped behavior verified against `src/vault/base.rs`, `src/vault/query.rs`, `src/api/bases.rs`, `src/api/properties.rs`, and `ui/src/components/bases/`.
- Keep the primary audience to vault users and base authors; do not turn the guide into an HTTP API reference.
- Use one internally consistent sample page and base throughout.
- Do not document internal phasing, migration history, speculative layouts, formulas, rollups, or base-editing UI as available features.
- Preserve unrelated worktree changes and stage only files owned by this plan.

---

### Task 1: Publish the practical Bases guide

**Files:**
- Create: `docs/bases.md`
- Modify: `docs/getting-started.md:155-189`
- Modify: `docs/lsp.md:70-83`

**Interfaces:**
- Consumes: `BaseFile`, `PropertyDefinition`, `PropertyType`, `Filter`, `Op`, `ViewDefinition`, `Aggregate`, and `SYSTEM_FIELDS` from `src/vault/base.rs`; the `/bases/$slug` route and cell editors from `ui/src/routes/bases.$slug.tsx` and `ui/src/components/bases/`.
- Produces: a canonical `docs/bases.md` user guide linked from setup and LSP documentation.

- [ ] **Step 1: Establish the exact shipped vocabulary**

Record these source-verified tokens in working notes before drafting:

```text
Property types: text, number, bool, date, datetime, select, multi_select, url, relation
Operators: eq, ne, lt, lte, gt, gte, contains, in, links_to, is_empty, not_empty
System fields: id, path, title, kind, project, tags, aliases, created_at, updated_at, journal_date, word_count
Sort directions: asc, desc
Aggregates: count, sum, avg, min, max
Layout shipped in the UI: table
Base path: <vault>/bases/<slug>.base.toml
UI path: /bases/<slug>
```

Verify each list directly against `src/vault/base.rs`; verify route behavior against `src/api/bases.rs` and `ui/src/routes/bases.$slug.tsx`.

- [ ] **Step 2: Write the minimal working example**

Create `docs/bases.md` with an opening explanation that a base is a non-owning view over pages, then use this page/base pair:

```toml
+++
title = "The Book of the New Sun"
kind = "BOOK"
author = "Gene Wolfe"
status = "reading"
rating = 4.5
started = 2026-07-30
+++
```

```toml
# <vault>/bases/reading.base.toml
name = "Reading Log"
description = "Books in flight and their wake."

[filter]
field = "kind"
op = "eq"
value = "BOOK"

[properties]
author = { type = "text" }
status = { type = "select", options = ["queued", "reading", "finished", "abandoned"] }
rating = { type = "number" }
started = { type = "date" }

[[views]]
name = "Continues"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [{ field = "started", dir = "desc" }]
columns = ["title", "author", "rating", "started"]
```

Explain that `reading.base.toml` yields slug `reading`, the matching UI is `/bases/reading`, the base owns no pages, and deleting it does not delete matching pages.

- [ ] **Step 3: Add the authoring reference**

Continue `docs/bases.md` with concise sections for:

```text
File location and slug
Page properties and advisory schemas
Property type table
System fields and sys./prop. disambiguation
Membership and saved-view filters
Boolean all/any/not filters
View columns, sorting, grouping, and aggregates
Web UI behavior and inline editing
Neovim/LSP completions and warnings
Validation, troubleshooting, and v1 limits
```

Include a filter operator table with type restrictions: ordering operators for `number`, `date`, and `datetime`; `links_to` for relations; `contains` for text substring or multi-valued membership; `in` with an array; and empty checks without a meaningful value. State that a base property schema is advisory and mismatches produce diagnostics rather than blocking indexing.

For nested filters, show the readable TOML array-of-tables spelling and explain that membership and view filters are ANDed. For views, state that `group_by` uses a declared property and that `count` needs no field while numeric/date aggregates need a compatible field. Keep examples inside the behavior accepted by `BaseRegistry::load` and `evaluate`.

- [ ] **Step 4: Add discoverability links**

In `docs/getting-started.md`, add one sentence after the Neovim/LSP introduction pointing users who want typed properties and filtered table views to `docs/bases.md`.

In `docs/lsp.md`, add one sentence after the capabilities table pointing to `docs/bases.md` for base schemas, matching, property completions, and diagnostics. Do not duplicate the reference tables.

- [ ] **Step 5: Check documentation accuracy and links**

Run targeted text checks:

```bash
git diff --check -- docs/bases.md docs/getting-started.md docs/lsp.md
```

Then manually compare every token table and TOML example against `src/vault/base.rs`, `src/vault/query.rs`, and `tests/bases_api.rs`. Confirm each relative Markdown link resolves to an existing file.

- [ ] **Step 6: Run required repository gates**

Run:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
```

Expected: every command exits successfully. Any failure caused by pre-existing unrelated worktree changes must be reported precisely; do not modify those files.

- [ ] **Step 7: Commit the user documentation**

```bash
git add docs/bases.md docs/getting-started.md docs/lsp.md
git commit -m "docs: add bases authoring guide"
```
