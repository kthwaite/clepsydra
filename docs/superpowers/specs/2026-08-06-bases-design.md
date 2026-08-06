# Bases: TOML Frontmatter, Typed Properties, Filtered Views, Aggregation

**Date:** 2026-08-06
**Status:** Draft for review, rev 2 — TOML baseline
**Working name:** "bases". Rename to fit the vessel vocabulary at will — *Registers* is offered as a candidate.

---

## 1) Scope

### In scope

- **Frontmatter migrates from YAML to TOML** (`+++` fences, Hugo convention). Dual-read during transition; single-write TOML; heal-on-touch conversion plus a `clep migrate` sweep. serde_yaml is quarantined to a legacy reader module and removed once `doctor` reports zero `---` pages.
- Surgical frontmatter edits via `toml_edit`: the property patch path rewrites only the touched keys, preserving comments, whitespace, and key order everywhere else.
- A `page_properties` EAV table in the vault index, populated by a new `PropertyDeriver` from every page's frontmatter extras. Schema-blind: all keys indexed, projections taken from **native TOML types** — no string sniffing.
- A **base**: a TOML file under `bases/` declaring (a) a membership filter, (b) a property schema, (c) saved views. Bases are views over pages; they never own pages. A page may match many bases; deleting a base deletes nothing else.
- A filter/sort/group/aggregate **query engine** compiling a small filter AST to SQL over `pages`, `page_properties`, `tags`, and `links`.
- HTTP API: base listing/detail, view evaluation, a generic query endpoint, and a targeted **property patch** endpoint riding the mutation coordinator.
- Watcher extension: `bases/*.base.toml` changes reload the base registry and notify clients over SSE.
- LSP: frontmatter property **key completion** (from matching bases), **value completion** (select options; relation targets via the existing wikilink completer), and **type-mismatch diagnostics** — all against the `+++` region.
- `doctor` checks: legacy-frontmatter census, base file validation, property/system-field shadowing warnings, type-violation census.
- UI: a table layout per view (react-aria-components `Table`), inline cell editing, group headers with aggregates, Vessel-styled.
- Pilot consumer: `bases/reading.base.toml` backing the deferred Codex Reading Log (`_features/004`).

### Explicitly out of scope

- **Formulas and rollups.** The scope trap. Not in v1, not designed-for in v1. (If they ever graduate, the reserved option is an s-expression filter/formula surface parsing to the same AST — recorded here so the door stays visibly open.)
- **Non-table layouts** (board/calendar/gallery). The query engine is layout-agnostic; layouts beyond table are follow-ups.
- **TASKING migration.** WIP limits, cycle sealing, and carryover are workflow semantics, not views. It stays bespoke until the generic system earns the port.
- **Base-editing UI.** Bases are authored by hand (Neovim-first is the point). The UI renders and edits *cells*, not schemas.
- **Date bucketing in group_by.** Group keys are raw values in v1.
- **Container semantics.** No rows without backing pages, ever.
- **iOS surface.** Separate design when the API stabilizes.
- **LSP service for `.base.toml` files themselves.** `doctor` + API diagnostics cover base validation in v1.

---

## 2) Frontmatter: TOML

### Format

```toml
+++
id = "01900000-0000-7000-8000-000000000001"
title = "The Book of the New Sun"
type = "BOOK"
tags = ["sf", "wolfe"]
created_at = 2026-08-06T09:00:00Z
updated_at = 2026-08-06T09:00:00Z

# --- properties (any base may interpret these) ---
author = "Gene Wolfe"
status = "reading"
rating = 4.5
started = 2026-07-30
series = ["[[Solar Cycle]]"]
+++
Body begins here.
```

`+++` fences delimit TOML; `---` fences continue to mean legacy YAML for as long as any survive. Detection is on the first three bytes of the file — the two parsers never overlap.

Why TOML: `toml_edit` gives lossless, comment- and order-preserving surgical edits (the capability whose absence was the serde_yaml risk); native date/date-time/integer/float/boolean types delete the coercion ambiguity YAML forces (`3.5` vs `"3.5"`, the Norway problem, regex-gated dates); and **TOML has no null**, so absence is the *only* empty state — `is_empty` semantics stop needing a special case. Costs accepted: quoted strings, and deep nesting expressed as dotted keys or sub-tables (the academic `archive.*`/`work.*` blobs become `[archive]` tables — they are machine-written and unaffected in meaning).

### Internal representation

`PageMeta.extra` becomes `HashMap<String, toml::Value>` — **not** `serde_json::Value`. The deriver must see native TOML types to project dates and numbers without sniffing, and `toml::value::Datetime` uses a private serde representation that mangles a transparent flatten-through-JSON. Therefore the JSON conversion is explicit and happens exactly once, at the `meta_json` write site: `toml_value_to_json` maps date-times to ISO 8601 strings and everything else structurally. System timestamps (`created_at`/`updated_at`) serialize as native TOML offset date-times via custom (de)serialize at the chokepoint. Everything downstream of `meta_json` (pages API DTOs, board `extra_str`, archive hooks) is untouched — it already consumes JSON strings.

### Write paths

Two, deliberately:

1. **Full serialization** (`write_page_content`) — page creation and whole-meta updates. Canonical key order: `id`, `title`, `type`, `project`, `tags`, `aliases`, `created_at`, `updated_at`, then extras in first-seen order. Used where no prior formatting exists to preserve.
2. **Surgical splice** — the property patch. Read raw content → parse the `+++` region with `toml_edit::DocumentMut` → assign/remove keys in place (plus `updated_at`) → splice the region back → `ReplacePageContentCommand { expected content }`. Comments and untouched keys survive byte-for-byte. This is the marquee property of the migration and gets its own test.

`parse_or_repair` semantics carry over unchanged in spirit: strict parse, then a loose salvage model, then default-meta-without-rewrite for unparseable frontmatter, with the same warning surface.

### Migration

Heal-on-touch: any mutation through the coordinator writes TOML, converting the file as a side effect of whatever the user was doing — ADR-0001's drift philosophy applied to syntax. `clep migrate` sweeps the remainder: for each `---` page, legacy-parse → full TOML serialization → atomic write, with a dry-run mode and a per-file report. `doctor` gains a legacy census (count + paths of `---` pages). serde_yaml survives only inside `src/vault/legacy_yaml.rs` until the census reads zero, then both go.

One-way door, stated plainly: after conversion, YAML comments in frontmatter are lost (full serialization does not carry them). The vault should be committed before the sweep; the sweep says so.

---

## 3) The base file

Location: `<vault>/bases/<slug>.base.toml`. The slug is the filename stem; it is the API identity. `bases/` is not walked for pages and is added to `excluded_patterns` defaults for explicitness.

```toml
# bases/reading.base.toml
name = "Reading Log"
description = "Books in flight and their wake."

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
author   = { type = "text" }
status   = { type = "select", options = ["queued", "reading", "finished", "abandoned"] }
rating   = { type = "number" }
pages    = { type = "number" }
progress = { type = "number" }
started  = { type = "date" }
finished = { type = "date" }
series   = { type = "relation" }
themes   = { type = "multi_select", options = [] }   # empty options = open vocabulary

[[views]]
name = "Continues"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [ { field = "started", dir = "desc" } ]
columns = ["title", "author", "progress", "pages"]

[[views]]
name = "Shelf"
layout = "table"
group_by = "status"
aggregates = [ { fn = "count" }, { fn = "avg", field = "rating" } ]
sort = [ { field = "finished", dir = "desc" } ]
columns = ["title", "author", "rating", "finished"]
```

**Deep filters.** TOML 1.0 inline tables are single-line, so nested boolean groups written inline get ugly fast. The array-of-tables form is the sanctioned spelling for anything non-trivial — serde sees an identical structure either way:

```toml
[[filter.all]]
field = "kind"
op = "eq"
value = "BOOK"

[[filter.all]]
  [[filter.all.any]]
  field = "status"
  op = "eq"
  value = "reading"

  [[filter.all.any]]
  field = "status"
  op = "eq"
  value = "queued"
```

This is the one place TOML is genuinely worse than the alternatives; it is tolerable at realistic filter depth, and it is the exact spot the reserved s-expression option would slot in if filters ever grow beyond it.

### Property types (v1)

`text`, `number`, `bool`, `date`, `datetime`, `select`, `multi_select`, `url`, `relation`.

- `select` / `multi_select` carry `options`; an empty list means open vocabulary (completion offers observed values; no diagnostics for novel ones).
- `relation` values are wiki-links (`"[[Solar Cycle]]"`), naturally multi-valued as a TOML array. `many = false` is an advisory constraint (diagnostic, never enforcement).
- Typing is **advisory everywhere** — but note the ground shifted: with native TOML types, a mismatch is now *visible in the file* (`rating = "4"` is unambiguously a string where a number is declared). Diagnostics point at real, fixable facts instead of coercion guesses. Nothing ever blocks indexing.

### Field namespace

System fields are addressable in filters/sorts/columns without declaration: `id`, `path`, `title`, `kind`, `project`, `tags`, `aliases`, `created_at`, `updated_at`, `journal_date`, `word_count`. Resolution is **system-first**: a bare name binds to the system field if one exists, else to a property. Explicit escapes `sys.<name>` / `prop.<name>` disambiguate.

Concretely: academic pages carry a frontmatter `kind = "work"` extra. In a filter, bare `kind` means the resolved page kind (the `pages.kind` column); the academic extra is reachable as `prop.kind`. `doctor` warns whenever a vault property shadows a system field. Bases may not *declare* properties with system-field names.

---

## 4) Index: `page_properties`

```sql
CREATE TABLE IF NOT EXISTS page_properties (
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    ord         INTEGER NOT NULL DEFAULT 0,   -- element position for arrays
    value_json  TEXT NOT NULL,                -- canonical JSON (date-times as ISO strings)
    value_text  TEXT,                         -- textual projection
    value_num   REAL,                         -- numeric projection (native int/float only)
    value_date  TEXT,                         -- ISO 8601 (native TOML date types only)
    value_bool  INTEGER,                      -- 0/1 (native boolean only)
    PRIMARY KEY (page_id, key, ord)
);
CREATE INDEX IF NOT EXISTS idx_page_props_key_text ON page_properties(key, value_text);
CREATE INDEX IF NOT EXISTS idx_page_props_key_num  ON page_properties(key, value_num);
CREATE INDEX IF NOT EXISTS idx_page_props_key_date ON page_properties(key, value_date);
```

`PropertyDeriver` (registered after `TagDeriver`) walks `page.meta.extra`. Projections come from **native types only** — a string never gains `value_num` or `value_date`; that was YAML-era compensation and it is gone:

| TOML value | rows | projections |
|---|---|---|
| string | 1 | `value_text` (wiki-link strings stay raw; resolution is the links table's job) |
| integer / float | 1 | `value_num` + formatted `value_text` |
| boolean | 1 | `value_bool` + `"true"`/`"false"` text |
| local date / local date-time / offset date-time | 1 | `value_date` (ISO 8601, normalized) + text |
| local time | 1 | `value_text` only (not a date) |
| array | one per element | element rule applies per row |
| table | 1 | opaque `value_json` only; not filterable in v1 |
| empty string / empty array | 0 | absence is the empty state (`is_empty` relies on this; TOML's lack of null makes it the *only* rule) |

The deriver is base-agnostic. Base edits never require re-derivation of properties — with one exception, below.

### The linkable-set epoch

Frontmatter link extraction currently scans only `config.vault.linkable_properties` (default `tags`, `aliases`). Relation filters need `PropertyRef` rows for every relation-typed property, so the **effective linkable set** becomes `config ∪ { relation-typed keys across all bases }`. Two consequences:

1. The base registry must load **before** page indexing in the build sequence.
2. Skip-unchanged breaks silently when the effective set changes: an unchanged file whose `series` just became a relation would never get its links re-derived. Fix: persist a blake3 of the sorted effective set in a `derivation_meta(key, value)` table; on mismatch, disable skip-unchanged for one build. At <50k pages a forced full re-derive is an acceptable, rare cost.

---

## 5) Query engine

### Filter AST

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    All(Vec<Filter>),
    Any(Vec<Filter>),
    Not(Box<Filter>),
    #[serde(untagged)]
    Cmp { field: FieldRef, op: Op, #[serde(default)] value: serde_json::Value },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq, Ne, Lt, Lte, Gt, Gte,
    Contains,        // substring on text; membership on multi-valued
    In,              // value is an array
    LinksTo,         // relation → links table, canonical-name match
    IsEmpty, NotEmpty,
}
```

The same AST deserializes from base files (TOML) and the generic query endpoint (JSON), and registers in the OpenAPI schema. **No string DSL.** If a human-writable expression syntax is ever wanted, it parses *to* this AST; nothing else changes.

### Compilation

One predicate → one clause. System fields compile to column predicates on `pages` (with `tags` via `EXISTS (SELECT 1 FROM tags …)`). Properties compile to `EXISTS` subqueries on `page_properties`, choosing the typed column by the **declared** type in the enclosing base (`number` → `value_num`, `date`/`datetime` → `value_date`, `bool` → `value_bool`, else `value_text`). The generic query endpoint, having no base context, accepts an optional inline `types` map and defaults to text. Multi-valued "any element matches" and `IsEmpty` = `NOT EXISTS` fall out naturally. Filter date literals arrive as ISO strings and compare against `value_date` textually — ISO 8601 collates correctly.

`LinksTo` compiles against `links`: `EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.id AND l.source_field = :key AND (l.target_id = :id OR l.target_canonical = :canonical))` — target given as UUID or canonicalized name.

**Sort**: system fields order by column; properties get one `LEFT JOIN page_properties s<i> ON s<i>.page_id = p.id AND s<i>.key = :key AND s<i>.ord = 0` each, ordered as `s<i>.<col> IS NULL, s<i>.<col> [DESC]` (nulls last). Relation sorts order by first target's canonical name via a correlated subquery.

**Group + aggregate**: `group_by` must be a declared `select`, `bool`, `text`, or single-valued property; the group key is the `ord = 0` projection (`NULL` bucket = "empty"). Aggregates: `count` (always), `sum|avg|min|max` over `value_num`, `min|max` over `value_date`. Grouped responses return every group with its aggregates and up to `group_row_limit` rows each (default 50) plus a per-group total; flat responses use the existing `PaginationParams`. In-memory slicing per `api/pagination.rs` conventions is fine at declared scale.

---

## 6) HTTP API

| Route | Purpose |
|---|---|
| `GET /api/vault/bases` | Registry listing: slug, name, view names, diagnostic counts |
| `GET /api/vault/bases/{slug}` | Full parsed definition + diagnostics |
| `GET /api/vault/bases/{slug}/views/{view}` | Evaluated view (accepts pagination + ephemeral filter/sort overrides) |
| `POST /api/vault/query` | Generic engine: `{ filter, sort, group_by, aggregates, columns, types, limit, offset }` |
| `PATCH /api/vault/pages/{id}/properties` | `{ set: { key: value, … }, clear: [key, …], types: { key: type, … }, expected_revision }` |

The view endpoint is sugar over the query engine — one evaluator, two entry points.

**Property patch** is the only new write path, and it is a *splice*, not a rewrite: read raw → `toml_edit` the `+++` region in place (set/remove keys, bump `updated_at`) → `ReplacePageContentCommand` with the expected content for optimistic concurrency → index rebuild → SSE. Comments and untouched keys are preserved byte-for-byte — the serde_yaml lossiness risk from rev 1 is retired by construction, not deferred. The response embeds the refreshed row (the board's read-after-write pattern) so the UI reconciles without waiting on the SSE round-trip. Conflicts return 409 with the current revision. A patch against a legacy `---` page heals it to TOML first (full serialization), then splices — one documented exception to comment preservation, and only during the transition.

**Value typing on write.** PATCH values arrive as JSON, which has no date type. The optional `types` map disambiguates: a key hinted `date`/`datetime` with an ISO-string value is written as a native TOML date-time; unhinted JSON maps naturally (string→string, integral number→integer, else float, bool, array). The UI always sends hints from the base schema it is rendering, so the common path is deterministic; Neovim writes native types directly and never touches this endpoint.

**SSE**: page mutations already notify. Add a `BaseRegistryChanged` event so open views refetch on base edits.

---

## 7) Base registry + watcher

`BaseRegistry` lives in the vault context: parse all `bases/*.base.toml` at startup (before the first index build, per §4), hold `Vec<BaseDefinition>` + per-file diagnostics behind `parking_lot::RwLock`. Parse failures never poison the registry — a broken base is listed with its diagnostics and excluded from evaluation.

The debounced watcher currently drops every non-`.md` path at the first gate. Extend the event mapper: paths under `bases/` with the `.base.toml` suffix map to a new `ChangeEvent::BaseChanged`, handled by registry reload → linkable-epoch check (§4) → SSE. Everything else non-`.md` stays dropped.

Validation performed at parse (surfaced via API + `doctor`): unknown type tokens, system-name property declarations, filter fields referencing undeclared properties (warning — the vault may legitimately carry keys the base doesn't declare), op/type mismatches (`gt` on `select`), malformed view references, duplicate slugs.

---

## 8) LSP

All three capabilities key off frontmatter position detection — the region between the `+++` fences, resolvable from the existing ropey documents — plus the base registry. Legacy `---` pages get no property intelligence; the census-driven migration makes this self-limiting.

- **Key completion**: at column 0 inside the fences, offer property keys from every base whose filter the current page matches, then keys from other bases at lower sort text, completing to `key = `. Matching evaluates the base filter against the in-memory document's parsed meta — cheap, no SQL.
- **Value completion**: after `known_key = "`, offer `options` for select/multi_select; for `relation` keys, delegate to the existing wikilink canonical-name completer so `[[` behaves identically in body and frontmatter strings.
- **Diagnostics**: per matching base, type-check declared properties on the page — string-where-number (`rating = "4"`), string-where-date, closed-vocabulary `select` violations, unresolvable relation targets (reusing the body-link diagnostic machinery). Native types make every one of these a hard fact about the file rather than a coercion opinion. Severity: warning, never error. Published on the existing didOpen/didChange/didSave cycle.

---

## 9) UI

Route `/bases/$slug` with a view switcher (Zustand for ephemeral view UI state; last-selected view via the vault-meta KV once that lands). One `BaseTable` on react-aria-components `Table` with column sorting mapped to query sort, grouped rendering with aggregate header rows, and per-type cell editors: text/number inputs, select via existing listbox primitives, `DatePicker` (react-aria), bool switch, relation cells reusing the `ProjectCombo`/wikilink combobox pattern. Cell commit → property PATCH carrying `types` hints from the base schema → optimistic update, reconciled by the embedded read-back row; SSE invalidates the view query for external edits (the Neovim case). Vessel styling: zero radius, hard shadows, JetBrains Mono for the grid — a data table is the most Vessel surface this app will ever have.

Column `title` renders as the page link; every row is a page and navigates like one.

---

## 10) Pilot: Reading Log

`bases/reading.base.toml` (as in §3) resolves `_features/004`'s open questions: books are BOOK pages with declared properties; progress is a property patch from the panel or Neovim; the "Reading Continues" panel consumes `GET /bases/reading/views/continues` and drops its hardcoded Calvino/Borges/Murray entries. The `VITE_ENABLE_PROSPECTIVE_PANELS` gate lifts for that panel. Habits (006) and Inquiry (005) get the same treatment as follow-ups once the pilot proves the shape.

---

## 11) Phasing

| Phase | Delivers | Depends on |
|---|---|---|
| 0 | TOML frontmatter: dual-read, TOML write, toml_edit splice, `clep migrate`, doctor census | — |
| 1 | `page_properties` schema + `PropertyDeriver` (native-type projections) | 0 |
| 2 | Base file format, registry, watcher extension, linkable epoch, doctor checks | 1 |
| 3 | Filter AST + SQL compilation + sort/group/aggregate | 1, 2 |
| 4 | HTTP API + property PATCH (splice) + OpenAPI regen | 0, 3 |
| 5 | LSP completion + diagnostics | 0, 2 |
| 6 | UI table view + inline editing | 4 |
| 7 | Reading Log pilot | 4, 6 |

Phase 0 is independently shippable and valuable on its own (lossless machine edits benefit every existing mutation path). Phases 5 and 6 are parallelizable after 4. The companion implementation plan expands these into tasks.
