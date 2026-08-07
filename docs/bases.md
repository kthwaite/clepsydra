# Bases

A base is a saved, non-owning view over pages in a vault. It declares which pages belong to the base, gives their frontmatter properties advisory types, and defines table views over the matching pages. The pages remain ordinary Markdown files: a base does not move, copy, or own them.

## Minimal working example

Place a page under `<vault>/books/` (for example, `<vault>/books/the-book-of-the-new-sun.md`) with this TOML frontmatter:

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

The `books/` folder makes the page's resolved system `kind` equal to `BOOK`. In page frontmatter, `kind` itself is an ordinary property; the explicit system key is `type = "BOOK"`. A page elsewhere in the vault therefore needs `type = "BOOK"` to match the system-field filter below. See [System fields and field names](#system-fields-and-field-names) for the distinction.

Create the base file:

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

The filename `reading.base.toml` gives the base the slug `reading`, so its web UI is `/bases/reading`. The base membership filter selects books, and the saved view adds the `status = "reading"` filter. The base owns no pages; deleting `reading.base.toml` deletes neither the matching pages nor their properties.

## File location and slug

Base definitions live at:

```text
<vault>/bases/<slug>.base.toml
```

Only files ending in `.base.toml` in that directory are loaded. The filename stem is the API and UI identity: `deep-work.base.toml` has slug `deep-work` and UI path `/bases/deep-work`.

A base requires `name`. `description`, `filter`, `properties`, and `views` are optional, although the web UI needs at least one view to display a table. With no membership `filter`, the base matches every indexed page.

## Page properties and advisory schemas

The `[properties]` table describes page frontmatter keys; it does not create storage separate from the pages. Values retain their native TOML types when indexed. A declaration controls typed filtering, grouping, editing, completions, and warnings.

Schemas are advisory. A page whose value disagrees with a declaration still indexes, and the declaration does not rewrite or reject it. Clepsydra reports a warning instead. Likewise, `options` constrain diagnostics and completions rather than blocking an unfamiliar value, and `many = false` on a relation warns about multiple targets rather than enforcing a write constraint.

An empty `options` list means an open vocabulary. The LSP can offer values already observed in the vault and does not warn about new ones.

## Property types

| Type | Page frontmatter value | Schema details |
| --- | --- | --- |
| `text` | TOML string | Free text. |
| `number` | TOML integer or float | Uses numeric filtering, sorting, and aggregates. |
| `bool` | TOML boolean (`true` or `false`) | Edited as a boolean in the table UI. |
| `date` | Unquoted TOML date, such as `2026-07-30` | Quoting the date turns it into text and produces a warning. |
| `datetime` | Unquoted TOML date-time | Use a TOML date-time such as `2026-07-30T14:30:00Z`. |
| `select` | One TOML string | `options = [...]` declares the vocabulary; an empty list is open. |
| `multi_select` | An array of TOML strings | `options` has the same advisory behavior as `select`. |
| `url` | TOML string | Uses the text editor in the table UI. |
| `relation` | A string or array of strings, normally wikilinks such as `"[[Solar Cycle]]"` | `many = false` advises one target; relations participate in link resolution. |

These are the complete shipped type tokens: `text`, `number`, `bool`, `date`, `datetime`, `select`, `multi_select`, `url`, and `relation`.

## System fields and field names

The built-in system fields are:

```text
id, path, title, kind, project, tags, aliases, created_at, updated_at, journal_date, word_count
```

They can all be used in columns and with their supported filter operators without property declarations. Scalar system fields can also be used for sorting; `tags` and `aliases` cannot be sorted because they are multi-valued. A bare field name resolves system-first, so `kind` means the resolved page kind and `prop.kind` means a raw page property named `kind`. Use `sys.kind` to make the system-field intent explicit. The same `sys.` and `prop.` prefixes work for other field references.

A base may not declare a property whose name shadows a system field. If a page already has such an extra key, it can still be addressed with `prop.<name>`, but the base loader reports an undeclared-property diagnostic because it cannot appear in `[properties]`.

The system `kind` comes from the page's `type` frontmatter key, or from its top-level folder when `type` is absent. This is why the minimal example under `books/` matches `field = "kind"` even though its extra `kind` property is not the system field.

## Membership and saved-view filters

A comparison filter has `field`, `op`, and usually `value`:

```toml
[filter]
field = "rating"
op = "gte"
value = 4
```

The operators are:

| Operator | Meaning and restrictions |
| --- | --- |
| `eq` | Equal to a compatible scalar value; on multi-valued fields, matches membership. |
| `ne` | Not equal; on multi-valued fields, no element may equal the value. Missing properties also match. |
| `lt`, `lte`, `gt`, `gte` | Ordering comparisons. For declared properties, use only `number`, `date`, or `datetime`. |
| `contains` | Substring match on text; exact membership on multi-valued values such as `multi_select`, `tags`, and `aliases`. |
| `in` | Matches any candidate in an array, for example `value = ["queued", "reading"]`. |
| `links_to` | Relation target match by page UUID or canonical name. Use with `relation` properties. |
| `is_empty` | The field is absent or empty. Omit `value`; it has no meaningful value. |
| `not_empty` | The field is present and non-empty. Omit `value`; it has no meaningful value. |

`contains` is also an exact match for declared `select` and `relation` values. Ordering a declared non-orderable type produces a diagnostic and the view query can fail when an operator or value is incompatible with its field.

### Boolean filters

Filters compose with `all` (every child), `any` (at least one child), and `not` (negate one child). For nested filters, TOML arrays of tables are easier to read than deeply nested inline tables:

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

The equivalent shape is “kind is BOOK AND (status is reading OR queued).” An inline `not` is useful for one predicate:

```toml
filter = { not = { field = "status", op = "eq", value = "abandoned" } }
```

A base's membership filter and a selected view's filter are always ANDed. A view filter narrows membership; it cannot add a page that the base filter excluded.

## Views: columns, sorting, grouping, and aggregates

Each `[[views]]` entry is a saved view. Its fields are:

- `name`: required and unique within the base.
- `layout`: `table` is the only shipped layout and is the default.
- `filter`: an optional additional filter, ANDed with base membership.
- `columns`: field names in display order. The web UI falls back to `title` when this is empty.
- `sort`: an ordered list of `{ field, dir }` keys. Directions are `asc` and `desc`; omitted `dir` defaults to `asc`. Equal values use page path as a stable tie-breaker.
- `group_by`: a grouping field.
- `aggregates`: aggregate calculations shown with grouped results.

Use a property in `group_by` only when it is declared. Groupable property types are `select`, `text`, `bool`, `date`, `datetime`, and `url`; scalar system fields such as `kind` are also groupable. `number`, `relation`, and `multi_select` properties are not groupable.

The shipped aggregate functions are `count`, `sum`, `avg`, `min`, and `max`. `count` needs no field. The other functions require a compatible declared `number`, `date`, or `datetime` field (or the numeric system field `word_count`). Aggregates are returned with grouped results. For example:

```toml
[[views]]
name = "By status"
layout = "table"
group_by = "status"
aggregates = [
  { fn = "count" },
  { fn = "avg", field = "rating" },
]
sort = [{ field = "started", dir = "desc" }]
columns = ["title", "author", "rating", "started"]
```

## Web UI and inline editing

Open `/bases/<slug>` to use the base. The UI selects the first view initially and presents the other saved views as tabs. It renders flat or grouped tables, shows group counts and aggregate values, and lets you click a column header to apply a temporary ascending or descending sort override. Clicking a title opens that page.

System fields and undeclared columns are read-only. A column backed by a declared property opens a type-specific inline editor: text/URL, number, boolean, date, date-time, select, multi-select, or relation. Relation editing accepts comma-separated targets and writes wikilinks; single-target entry offers page-title suggestions. For a page that already uses TOML `+++` frontmatter, a successful edit surgically patches the frontmatter and updates `updated_at`, preserving untouched keys and comments. The first inline property edit on legacy YAML `---` frontmatter instead converts it to TOML through full serialization, so YAML frontmatter comments are not preserved. A stale edit is rejected rather than overwriting a newer page revision.

The UI does not author base definitions. Edit the `.base.toml` file to change membership, schemas, or saved views.

## Neovim/LSP completions and warnings

With `clep lsp` attached, completion inside a page's `+++` frontmatter offers property keys declared by bases. Properties from bases that match the current page rank first. Quoted values for `select` and `multi_select` complete from declared options; an open vocabulary can complete from observed vault values. Typing `[[` in a relation value uses normal wikilink completion.

For matching bases, the LSP warns about incompatible native TOML types, values outside a non-empty select vocabulary, multiple relation values when `many = false`, and unresolved relation targets. These are warnings, never indexing errors. Legacy `---` frontmatter does not receive property-schema diagnostics. The LSP completes and checks page frontmatter; it does not provide an editor for `.base.toml` files.

See [LSP setup and troubleshooting](lsp.md) for client configuration and the complete language-server capability list.

## Validation, troubleshooting, and v1 limits

Base files are parsed independently so one broken file does not poison the registry:

- Invalid TOML prevents that base from being evaluated; the Bases API still reports a diagnostic for its slug.
- An invalid property declaration is dropped, while valid declarations and the rest of the base remain available with a diagnostic.
- Other validation findings are advisory. Examples include a property shadowing a system field, an undeclared filter property, a non-orderable comparison, duplicate view names, an unsupported layout, or an aggregate missing its field.
- Some semantic errors are detected only when a view is evaluated. The web UI replaces the grid with the resulting view error.

If a base does not appear, check that it is directly under `<vault>/bases/`, ends in `.base.toml`, contains `name`, and has valid TOML. If `/bases/<slug>` says the base has no views, add at least one `[[views]]` entry. If date or number comparisons behave unexpectedly, verify the page uses native TOML values rather than quoted strings and that the property has the corresponding declaration.

V1 supports table layout only, does not provide base-definition authoring in the web UI, and caps displayed rows in each group at 50 while retaining the true group total. These limits do not change the non-owning model: pages can match any number of bases, and removing a base never removes pages.
