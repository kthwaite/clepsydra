# Bases: relative-date/text operators and flat-view aggregates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship TSK-0120 (relative-date + text filter operators) and TSK-0121 (footer aggregates on flat views + six new aggregate functions) for Bases, end to end: query engine, in-memory matchers, validation, API, OpenAPI, UI, docs.

**Architecture:** `Op` and `AggregateFn` are closed enums in `src/vault/base.rs`; the SQL compiler in `src/vault/query.rs` and the in-memory matchers in `base.rs`/`base_member.rs` must agree for every operator (a parity test already enforces this). Relative dates anchor on an evaluation date carried by `QueryContext` (`today`), supplied by the API layer from `state.clock` (the codebase convention: `clock.now().date_naive()`, i.e. the clock's UTC date — the same "today" Agenda and Journal use). Aggregates get one shared `AggregatePlan` used by both flat and grouped evaluation; medians are computed in Rust from an ordered fetch because SQLite has no MEDIAN. The UI derives operator and aggregate vocabularies from the regenerated OpenAPI schema.

**Tech Stack:** Rust 2024 / rusqlite / serde / utoipa / chrono; React 19 + TypeScript + Vitest + React Aria Components; Bun.

**Spec:** Task cards `tasks/clepsydra/TSK-0120.md` and `TSK-0121.md` in the vault, sourced from the vault note "Bases vs OpenBook: gap analysis" (`notes/20260828.bases-vs-openbook-gap-analysis.mFZUy3T5.md`). Section "Semantics" below is the binding spec for anything the cards leave open.

## Global Constraints

- Every new operator must evaluate identically in SQL (`src/vault/query.rs`) and in memory (`src/vault/base.rs` matchers used by member creation, LSP, and previews). Extend the existing parity tests (`src/vault/query.rs` test `in_memory_matches_sql…` near line 1860 and `src/vault/base_member.rs` test `composed_candidate_has_query_parity_for_every_supported_property_operator_pair` near line 815) to cover them.
- "Today" is `state.clock.now().date_naive()` in API handlers (UTC date of the clock). Never call `Utc::now()`/`Local::now()` inside an API handler; the engine's default (`QueryContext::for_base`) may use `Utc::now().date_naive()` only as a fallback for non-API callers (LSP, tests that don't care).
- Values are compared by their **date face** — the first ten characters (`YYYY-MM-DD`) of the stored ISO text — never converted between time zones. This holds for `value_date` (declared `date`/`datetime` properties), `created_at`/`updated_at` (RFC 3339 text), and `journal_date` (`YYYY-MM-DD`).
- Week starts **Monday** (ISO). `is_past_week` and `is_next_week` are **rolling seven-day windows** (see Semantics), not calendar weeks.
- Operator wire names are snake_case: `not_contains`, `starts_with`, `ends_with`, `is_today`, `is_this_week`, `is_past_week`, `is_next_week`, `is_this_month`. Aggregate wire names: `count_empty`, `count_filled`, `percent_filled`, `count_unique`, `median`, `range`.
- Valueless operators (`is_empty`, `not_empty`, and the five relative-date ops) must serialize without a `value` key; a supplied value is a validation warning in base files and a validation error in embeds (matching existing embed behaviour for `is_empty`).
- Aggregates over a flat view are computed over the **whole predicate**, never the window (`limit`/`offset` must not change them).
- Never run `bun run format` or bare `biome check --write` across `ui/src` — scope biome to touched files (`bunx biome check --write <files>`). `cargo fmt` is fine.
- `ui/dist/` must exist for `cargo test` to compile (rust-embed) — it is already seeded in this worktree; do not delete it.
- All commands run from the worktree root `/Users/kit/Source/_p.pkm/clepsydra/.worktrees/bases-query-ops` (UI commands from its `ui/`).

## Semantics (binding)

Let `today` be the evaluation date and `d` the date face of the stored value. All windows are half-open `[start, end)`:

| Operator | Window | Example for today = 2026-08-28 (Friday) |
| --- | --- | --- |
| `is_today` | `[today, today+1)` | `[2026-08-28, 2026-08-29)` |
| `is_this_week` | `[monday(today), monday+7)` | `[2026-08-24, 2026-08-31)` |
| `is_past_week` | `[today-7, today+1)` — the last seven days **and today** | `[2026-08-21, 2026-08-29)` |
| `is_next_week` | `[today+1, today+8)` — the next seven days, **excluding today** | `[2026-08-29, 2026-09-05)` |
| `is_this_month` | `[first-of-month, first-of-next-month)` | `[2026-08-01, 2026-09-01)` |

Relative-date operators are valid on declared `date`/`datetime` properties and on the system fields `created_at`, `updated_at`, `journal_date`. Anything else: `QueryError::InvalidOp` at query time, an error diagnostic at validation time.

Text operators:

- `not_contains`: valid wherever `contains` is. On substring types (`text`, `url`, text system scalars) it is "no substring match"; on membership types (`select`, `multi_select`, `relation`, `tags`, `aliases`) it is "no element equals". **A missing property matches** (like `ne`).
- `starts_with` / `ends_with`: substring types only — declared `text`/`url` properties and system scalars whose `property_type()` is `Text` (`id`, `path`, `title`, `kind`, `project`, `created_at`, `updated_at`). ASCII case-insensitive, like `contains` (SQLite `LIKE`). Invalid on categorical/multi-valued fields.

Aggregates:

| Function | Field | Value |
| --- | --- | --- |
| `count` | none (ignored) | `COUNT(*)` |
| `count_filled` | any declared property or scalar system field | rows where the field is present (`COUNT(col)`) |
| `count_empty` | same | `COUNT(*) - COUNT(col)` |
| `percent_filled` | same | `ROUND(100.0 * COUNT(col) / COUNT(*), 1)`; `0` when the set is empty |
| `count_unique` | same | `COUNT(DISTINCT col)` (first array element only, `ord = 0`) |
| `sum`, `avg`, `min`, `max` | `number`, `date`, `datetime`, or `word_count` | unchanged |
| `range` | same | number: `MAX - MIN`; date/datetime: `julianday(MAX) - julianday(MIN)` in days |
| `median` | same | number: mean of the middle two of the non-null sorted values; date/datetime: the lower-middle value as text; `null` when no values |

`tags` and `aliases` cannot be aggregated (`InvalidAggregate`). `body` stays projection-only.

## File map

| File | Responsibility in this plan |
| --- | --- |
| `src/vault/base.rs` | `Op`/`AggregateFn` enums + capability gates; `relative_date_window`; in-memory matcher support; validation diagnostics |
| `src/vault/query.rs` | `QueryContext.today`; SQL for new ops; `AggregatePlan`; flat aggregates; median/range |
| `src/vault/base_member.rs` | thread `today` through candidate matching; parity test |
| `src/vault/base_embed.rs` | embed validation for new ops (`supports_operator`, valueless check) |
| `src/api/bases.rs`, `src/api/properties.rs`, `src/api/query.rs` | pass `state.clock` today into `QueryContext`; member creation passes today |
| `src/api/base_members.rs` | pass today into candidate matching |
| `tests/bases_api.rs` | integration coverage with `FixedClock` |
| `examples/openapi.rs`, `ui/package.json` | offline OpenAPI dump + regen script |
| `ui/src/api/schema.d.ts` | regenerated |
| `ui/src/components/bases/definition-model.ts` | `operatorsFor`, `AggregateFunction`, `aggregateFunctions` |
| `ui/src/components/bases/FilterComparisonEditor.tsx` | valueless ops, operator labels |
| `ui/src/editor/convert/baseEmbedMarkdown.ts`, `ui/src/components/bases/embed-semantic-validation.ts` | embed op allowlists mirror the server |
| `ui/src/components/bases/ViewDefinitionEditor.tsx` | aggregate function options |
| `ui/src/components/bases/BaseTableView.tsx` | shared `AggregateChips`; flat footer |
| `ui/src/api/bases.ts` | `mergeWindows` carries `aggregates` |
| `ui/src/docs/content/bases.mdx` | operator table, relative dates, aggregates, footer |

---

### Task 1: Operators — engine, matchers, validation, API threading

**Files:**
- Modify: `src/vault/base.rs` (Op enum ~line 109; PropertyType gates ~line 62; in-memory matchers ~lines 590-830; `validate_filter` ~line 1370; `base_matches_meta` ~line 447)
- Modify: `src/vault/query.rs` (`SysField` ~line 33; `QueryContext` ~line 145; `compile_cmp` ~line 483; `compile_membership` ~line 568; `compile_prop` ~line 617; tests ~line 1300+)
- Modify: `src/vault/base_member.rs` (`candidate_matches`/`composed_candidate_matches*` ~lines 86-180; `fixed_candidate_comparison_matches`; tests)
- Modify: `src/vault/base_embed.rs` (`validate_comparison` ~line 307; `supports_operator` ~line 451; `op_name` ~line 527)
- Modify: `src/api/bases.rs:408,630,695,742`, `src/api/properties.rs:480`, `src/api/query.rs:115`, `src/api/base_members.rs:343`
- Modify: `src/lsp/diagnostics.rs:130`, `src/lsp/mod.rs:1404` (only if the `base_matches_meta` signature changes; prefer keeping it)
- Test: `tests/bases_api.rs`

**Interfaces:**
- Produces: `Op::{NotContains, StartsWith, EndsWith, IsToday, IsThisWeek, IsPastWeek, IsNextWeek, IsThisMonth}`; `Op::is_relative_date(self) -> bool`; `Op::is_valueless(self) -> bool`; `Op::is_affix(self) -> bool`; `Op::as_str(self) -> &'static str`; `PropertyType::supports_relative_date(self)`; `PropertyType::supports_affix(self)`; `pub fn relative_date_window(op: Op, today: NaiveDate) -> Option<(NaiveDate, NaiveDate)>`; `pub fn date_face(text: &str) -> Option<NaiveDate>`; `QueryContext { base, types, today: NaiveDate }` with `QueryContext::with_today(self, NaiveDate) -> Self`; `pub fn base_matches_meta_on(base, meta, path, today: NaiveDate) -> bool` (existing `base_matches_meta` delegates with `Utc::now().date_naive()`); `candidate_matches(..., today)`, `composed_candidate_matches(..., today)`, `composed_candidate_matches_with_link_targets(..., today)` gain a trailing `today: NaiveDate` parameter.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Failing unit test for `relative_date_window` and `date_face` (base.rs tests module)**

```rust
#[test]
fn relative_date_windows_anchor_on_today() {
    use chrono::NaiveDate;
    let today = NaiveDate::from_ymd_opt(2026, 8, 28).unwrap(); // a Friday
    let d = |y, m, d| NaiveDate::from_ymd_opt(y, m, d).unwrap();
    assert_eq!(relative_date_window(Op::IsToday, today), Some((d(2026, 8, 28), d(2026, 8, 29))));
    assert_eq!(relative_date_window(Op::IsThisWeek, today), Some((d(2026, 8, 24), d(2026, 8, 31))));
    assert_eq!(relative_date_window(Op::IsPastWeek, today), Some((d(2026, 8, 21), d(2026, 8, 29))));
    assert_eq!(relative_date_window(Op::IsNextWeek, today), Some((d(2026, 8, 29), d(2026, 9, 5))));
    assert_eq!(relative_date_window(Op::IsThisMonth, today), Some((d(2026, 8, 1), d(2026, 9, 1))));
    // December rolls into the next year.
    let dec = d(2026, 12, 15);
    assert_eq!(relative_date_window(Op::IsThisMonth, dec), Some((d(2026, 12, 1), d(2027, 1, 1))));
    // A Monday is the start of its own week.
    assert_eq!(relative_date_window(Op::IsThisWeek, d(2026, 8, 24)), Some((d(2026, 8, 24), d(2026, 8, 31))));
    assert_eq!(relative_date_window(Op::Eq, today), None);
    assert_eq!(date_face("2026-08-28"), Some(d(2026, 8, 28)));
    assert_eq!(date_face("2026-08-28T23:59:00+05:00"), Some(d(2026, 8, 28)));
    assert_eq!(date_face("reading"), None);
    assert_eq!(date_face("2026-08"), None);
}
```

- [ ] **Step 2: Run it — expect a compile failure (`relative_date_window` undefined)**

Run: `cargo test --lib relative_date_windows_anchor_on_today`

- [ ] **Step 3: Add the enum variants, gates, window, and date face in `src/vault/base.rs`**

Replace the `Op` enum and its impl with:

```rust
/// Comparison operators for filter predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    /// Substring on text; membership on multi-valued.
    Contains,
    /// Negation of `contains`; a missing property matches, like `ne`.
    NotContains,
    /// Prefix match on substring-typed values (ASCII case-insensitive).
    StartsWith,
    /// Suffix match on substring-typed values (ASCII case-insensitive).
    EndsWith,
    /// Value is an array of candidates.
    In,
    /// Relation → links table, canonical-name (or UUID) match.
    LinksTo,
    IsEmpty,
    NotEmpty,
    /// Value-less relative-date predicates anchored on the evaluation date.
    IsToday,
    IsThisWeek,
    IsPastWeek,
    IsNextWeek,
    IsThisMonth,
}

impl Op {
    pub fn is_ordering(self) -> bool {
        matches!(self, Op::Lt | Op::Lte | Op::Gt | Op::Gte)
    }

    pub fn is_relative_date(self) -> bool {
        matches!(
            self,
            Op::IsToday | Op::IsThisWeek | Op::IsPastWeek | Op::IsNextWeek | Op::IsThisMonth
        )
    }

    /// Operators that take no `value`.
    pub fn is_valueless(self) -> bool {
        matches!(self, Op::IsEmpty | Op::NotEmpty) || self.is_relative_date()
    }

    /// `starts_with` / `ends_with`: substring-shaped, never membership.
    pub fn is_affix(self) -> bool {
        matches!(self, Op::StartsWith | Op::EndsWith)
    }

    /// The wire name (snake_case), for diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Eq => "eq",
            Op::Ne => "ne",
            Op::Lt => "lt",
            Op::Lte => "lte",
            Op::Gt => "gt",
            Op::Gte => "gte",
            Op::Contains => "contains",
            Op::NotContains => "not_contains",
            Op::StartsWith => "starts_with",
            Op::EndsWith => "ends_with",
            Op::In => "in",
            Op::LinksTo => "links_to",
            Op::IsEmpty => "is_empty",
            Op::NotEmpty => "not_empty",
            Op::IsToday => "is_today",
            Op::IsThisWeek => "is_this_week",
            Op::IsPastWeek => "is_past_week",
            Op::IsNextWeek => "is_next_week",
            Op::IsThisMonth => "is_this_month",
        }
    }
}

/// Half-open `[start, end)` date window for a relative-date operator.
/// Weeks start on Monday; `is_past_week` and `is_next_week` are rolling
/// seven-day windows (see the plan's Semantics table).
pub fn relative_date_window(op: Op, today: chrono::NaiveDate) -> Option<(chrono::NaiveDate, chrono::NaiveDate)> {
    use chrono::{Datelike, Duration, NaiveDate};
    let days = |n: i64| Duration::days(n);
    Some(match op {
        Op::IsToday => (today, today + days(1)),
        Op::IsThisWeek => {
            let monday = today - days(i64::from(today.weekday().num_days_from_monday()));
            (monday, monday + days(7))
        }
        Op::IsPastWeek => (today - days(7), today + days(1)),
        Op::IsNextWeek => (today + days(1), today + days(8)),
        Op::IsThisMonth => {
            let first = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)?;
            let next = if today.month() == 12 {
                NaiveDate::from_ymd_opt(today.year() + 1, 1, 1)?
            } else {
                NaiveDate::from_ymd_opt(today.year(), today.month() + 1, 1)?
            };
            (first, next)
        }
        _ => return None,
    })
}

/// The `YYYY-MM-DD` face of an ISO date or date-time string, as written
/// (no time-zone conversion).
pub fn date_face(text: &str) -> Option<chrono::NaiveDate> {
    let head = text.get(..10)?;
    chrono::NaiveDate::parse_from_str(head, "%Y-%m-%d").ok()
}
```

Add to `impl PropertyType`:

```rust
    /// Whether a relative-date predicate (`is_today`, …) is defined for the type.
    pub fn supports_relative_date(self) -> bool {
        matches!(self, PropertyType::Date | PropertyType::Datetime)
    }

    /// Whether `starts_with` / `ends_with` are defined: substring types only.
    /// Categorical and multi-valued types treat `contains` as membership, so
    /// affix matching has no meaning for them.
    pub fn supports_affix(self) -> bool {
        matches!(self, PropertyType::Text | PropertyType::Url)
    }
```

- [ ] **Step 4: Run the unit test — expect PASS**

Run: `cargo test --lib relative_date_windows_anchor_on_today`

- [ ] **Step 5: Failing SQL tests in `src/vault/query.rs` tests module**

Follow the existing fixture pattern in that module (look at how the tests around line 2070 build a `VaultIndex` with pages and call `evaluate(index.connection(), &spec, &QueryContext::for_base(&base))`). Seed pages under `books/` with frontmatter:

| page | `started` | `title` | `status` |
| --- | --- | --- | --- |
| `books/a.md` | `2026-08-28` | "Alpha Wolf" | `reading` |
| `books/b.md` | `2026-08-24` | "Beta" | `queued` |
| `books/c.md` | `2026-08-21` | "Gamma alpha" | `reading` |
| `books/d.md` | `2026-08-29T09:00:00Z` (datetime) | "Delta" | `finished` |
| `books/e.md` | `2026-07-31` | "Epsilon" | `reading` |
| `books/f.md` | (absent) | "Zeta" | (absent) |

Declare `started = { type = "datetime" }`, `title` is the system field, `status = { type = "select" }`. Write one test per operator with `today = 2026-08-28` via `QueryContext::for_base(&base).with_today(today)`; assert the set of matching paths:

```rust
#[test]
fn relative_date_ops_select_by_window() {
    let (index, base) = relative_date_fixture(); // builds the six pages above
    let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 28).unwrap();
    let paths = |op: Op| -> Vec<String> {
        let spec = QuerySpec {
            filter: Some(Filter::Cmp { field: "started".into(), op, value: serde_json::Value::Null }),
            sort: vec![], group_by: None, aggregates: vec![], columns: vec![],
            limit: None, offset: 0, group_row_limit: GroupRowLimit::Default,
        };
        let QueryOutput::Flat { rows, .. } =
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base).with_today(today)).unwrap()
        else { panic!("flat") };
        rows.into_iter().map(|r| r.path).collect()
    };
    assert_eq!(paths(Op::IsToday), ["books/a.md"]);
    assert_eq!(paths(Op::IsThisWeek), ["books/a.md", "books/b.md"]);
    assert_eq!(paths(Op::IsPastWeek), ["books/a.md", "books/b.md", "books/c.md"]);
    assert_eq!(paths(Op::IsNextWeek), ["books/d.md"]);
    assert_eq!(paths(Op::IsThisMonth), ["books/a.md", "books/b.md", "books/c.md", "books/d.md"]);
}

#[test]
fn relative_date_ops_reject_non_date_fields() {
    let (index, base) = relative_date_fixture();
    let spec = /* filter: status is_today */;
    assert!(matches!(
        evaluate(index.connection(), &spec, &QueryContext::for_base(&base)),
        Err(QueryError::InvalidOp { .. })
    ));
}

#[test]
fn relative_date_ops_work_on_created_at_and_journal_date() {
    // seed a journal page journals/2026-08-28.md and one at journals/2026-08-01.md;
    // `journal_date is_today` → only the first; `created_at is_this_month` → pages whose
    // created_at (set in PageMeta) falls in August 2026.
}

#[test]
fn text_affix_and_not_contains_ops() {
    let (index, base) = relative_date_fixture();
    // title starts_with "alpha" (case-insensitive) → a.md only
    // title ends_with "alpha" → c.md only
    // title not_contains "alpha" → b, d, e, f
    // status not_contains "reading" (membership) → b, d, f (f has no status → matches)
    // status starts_with "read" → Err(InvalidOp)
    // tags not_contains "x" → every page (none tagged)
}
```

Also extend the SQL-vs-in-memory parity test near line 1860 (`base_matches_meta` vs `compile_filter`) with cases for each new op; use `base_matches_meta_on(&base, &meta, "a.md", today)` and `QueryContext::for_base(&base).with_today(today)`.

- [ ] **Step 6: Run — expect compile failures (`with_today`, `base_matches_meta_on`) and then InvalidOp/false assertions**

Run: `cargo test --lib vault::query`

- [ ] **Step 7: Implement `QueryContext.today` and the SQL arms in `src/vault/query.rs`**

```rust
pub struct QueryContext<'a> {
    pub base: Option<&'a BaseDefinition>,
    pub types: HashMap<String, PropertyType>,
    /// Evaluation date for relative-date operators. API handlers set it from
    /// `state.clock`; the constructor defaults to the UTC date now.
    pub today: chrono::NaiveDate,
}

impl<'a> QueryContext<'a> {
    pub fn for_base(base: &'a BaseDefinition) -> Self {
        Self { base: Some(base), types: HashMap::new(), today: chrono::Utc::now().date_naive() }
    }

    pub fn with_today(mut self, today: chrono::NaiveDate) -> Self {
        self.today = today;
        self
    }
    // property_type unchanged
}
```

Add to `impl SysField`:

```rust
    pub(crate) fn supports_relative_date(self) -> bool {
        matches!(self, SysField::CreatedAt | SysField::UpdatedAt | SysField::JournalDate)
    }

    pub(crate) fn supports_affix(self) -> bool {
        self.property_type() == PropertyType::Text
    }
```

Helper next to `bind_literal_contains_value`:

```rust
fn bind_relative_window(op: Op, today: chrono::NaiveDate, params: &mut Vec<SqlValue>) {
    let (start, end) = relative_date_window(op, today).expect("caller checked is_relative_date");
    params.push(SqlValue::Text(start.format("%Y-%m-%d").to_string()));
    params.push(SqlValue::Text(end.format("%Y-%m-%d").to_string()));
}
```

In `compile_cmp`'s `ResolvedField::Sys(sys)` arm, add before the `_ =>` fallback (keep the existing arms):

```rust
                op if op.is_relative_date() => {
                    if !sys.supports_relative_date() {
                        return Err(QueryError::InvalidOp { field: field.to_string(), op });
                    }
                    bind_relative_window(op, ctx.today, params);
                    Ok(format!("({column} >= ? AND {column} < ?)"))
                }
                Op::NotContains if !sys.supports_contains() => Err(QueryError::InvalidOp { field: field.to_string(), op }),
                Op::NotContains => {
                    params.push(bind_literal_contains_value(field, PropertyType::Text, value)?);
                    Ok(format!("({column} IS NULL OR {column} NOT LIKE '%' || ? || '%' ESCAPE '\\')"))
                }
                Op::StartsWith | Op::EndsWith if !sys.supports_affix() => Err(QueryError::InvalidOp { field: field.to_string(), op }),
                Op::StartsWith => {
                    params.push(bind_literal_contains_value(field, PropertyType::Text, value)?);
                    Ok(format!("{column} LIKE ? || '%' ESCAPE '\\'"))
                }
                Op::EndsWith => {
                    params.push(bind_literal_contains_value(field, PropertyType::Text, value)?);
                    Ok(format!("{column} LIKE '%' || ? ESCAPE '\\'"))
                }
```

In `compile_membership` (tags/aliases) add `Op::NotContains` → `NOT EXISTS ({exists_prefix} = ?)` with the same value binding as `Ne`, and make sure affix/relative ops fall to the existing `InvalidOp` error arm.

In `compile_prop` add before the `Op::Ne` arm:

```rust
        op if op.is_relative_date() => {
            if !ty.supports_relative_date() {
                return Err(QueryError::InvalidOp { field: field.to_string(), op });
            }
            params.push(SqlValue::Text(key.to_string()));
            bind_relative_window(op, today, params); // pass ctx.today into compile_prop as a new parameter
            Ok(exists("pp.value_date >= ? AND pp.value_date < ?"))
        }
        Op::NotContains if !ty.supports_contains() => Err(QueryError::InvalidOp { field: field.to_string(), op }),
        Op::NotContains => {
            params.push(SqlValue::Text(key.to_string()));
            let predicate = if matches!(ty, PropertyType::MultiSelect | PropertyType::Select | PropertyType::Relation) {
                params.push(bind_value(field, ty, value)?);
                format!("pp.{column} = ?")
            } else {
                params.push(bind_literal_contains_value(field, ty, value)?);
                format!("pp.{column} LIKE '%' || ? || '%' ESCAPE '\\'")
            };
            // "No element matches": pages without the key also match.
            Ok(format!(
                "NOT EXISTS (SELECT 1 FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = ? AND {predicate})"
            ))
        }
        Op::StartsWith | Op::EndsWith if !ty.supports_affix() => Err(QueryError::InvalidOp { field: field.to_string(), op }),
        Op::StartsWith => {
            params.push(SqlValue::Text(key.to_string()));
            params.push(bind_literal_contains_value(field, ty, value)?);
            Ok(exists(&format!("pp.{column} LIKE ? || '%' ESCAPE '\\'")))
        }
        Op::EndsWith => {
            params.push(SqlValue::Text(key.to_string()));
            params.push(bind_literal_contains_value(field, ty, value)?);
            Ok(exists(&format!("pp.{column} LIKE '%' || ? ESCAPE '\\'")))
        }
```

`compile_prop` gains a `today: chrono::NaiveDate` parameter; `compile_cmp` passes `ctx.today`.

- [ ] **Step 8: Implement the in-memory side in `src/vault/base.rs`**

Thread `today: chrono::NaiveDate` through `base_matches_meta_on` → the filter walker → `property_matches` → `property_scalar_matches` → `scalar_matches`, and through the system-field matcher. Keep `base_matches_meta(base, meta, path)` as a thin wrapper calling `base_matches_meta_on(base, meta, path, chrono::Utc::now().date_naive())`.

In `scalar_matches`, before the `let Some(current) = current else { … }` line:

```rust
    if op.is_relative_date() {
        if !property_type.supports_relative_date() {
            return false;
        }
        let Some((start, end)) = relative_date_window(op, today) else { return false };
        return current
            .as_ref()
            .and_then(|value| date_face(&comparable_sql_text(value)))
            .is_some_and(|day| start <= day && day < end);
    }
```

Change the missing-value early return to `return matches!(op, Op::Ne | Op::NotContains) && expected_scalar(property_type, value).is_some();`.

Add arms:

```rust
        Op::NotContains if !property_type.supports_contains() => false,
        Op::NotContains => expected_scalar(property_type, value).is_some_and(|expected| {
            if contains_is_membership { !scalar_equal(&current, &expected) } else { !sql_contains(&current, &expected) }
        }),
        Op::StartsWith | Op::EndsWith if !property_type.supports_affix() => false,
        Op::StartsWith => expected_scalar(property_type, value).is_some_and(|expected| sql_affix(&current, &expected, true)),
        Op::EndsWith => expected_scalar(property_type, value).is_some_and(|expected| sql_affix(&current, &expected, false)),
```

with

```rust
fn sql_affix(current: &Comparable<'_>, expected: &Comparable<'_>, prefix: bool) -> bool {
    let current = comparable_sql_text(current);
    let expected = comparable_sql_text(expected);
    if expected.len() > current.len() {
        return false;
    }
    let window = if prefix { &current.as_bytes()[..expected.len()] } else { &current.as_bytes()[current.len() - expected.len()..] };
    window.eq_ignore_ascii_case(expected.as_bytes())
}
```

In `property_matches` for arrays: `Op::Ne | Op::NotContains => items.iter().all(|item| !property_scalar_matches(item, property_type, if op == Op::Ne { Op::Eq } else { Op::Contains }, value, today))`. In `membership_matches` (tags/aliases): `Op::NotContains => value.as_str().is_some_and(|expected| !contains(expected))`. For system scalar fields, the existing path builds a `Comparable` via `sys_comparable`; relative ops must go through the same `scalar_matches` with `PropertyType::Datetime` for `created_at`/`updated_at` and `PropertyType::Date` for `journal_date`, and affix ops with `PropertyType::Text` for text scalars — mirror `SysField::supports_relative_date`/`supports_affix` exactly so parity holds.

- [ ] **Step 9: Validation in `validate_filter` (base.rs) and `validate_comparison` (base_embed.rs)**

In `validate_filter`'s `Filter::Cmp` arm, after the body-field check add:

```rust
            if op.is_valueless() && !value.is_null() {
                push(
                    BaseDiagnosticSeverity::Warning,
                    Some(format!("{path}.value")),
                    format!("{context}: op `{}` does not accept a value", op.as_str()),
                );
            }
            if op.is_relative_date() {
                let supported = match resolve_field(field, &QueryContext::for_base(base)) {
                    Ok(ResolvedField::Sys(sys)) => sys.supports_relative_date(),
                    Ok(ResolvedField::Prop { ty, .. }) => ty.supports_relative_date(),
                    Err(_) => false,
                };
                if !supported {
                    push(BaseDiagnosticSeverity::Error, Some(format!("{path}.op")),
                        format!("{context}: op `{}` is only valid for date fields, not `{field}`", op.as_str()));
                    return;
                }
            }
            if op.is_affix() {
                let supported = match resolve_field(field, &QueryContext::for_base(base)) {
                    Ok(ResolvedField::Sys(sys)) => sys.supports_affix(),
                    Ok(ResolvedField::Prop { ty, .. }) => ty.supports_affix(),
                    Err(_) => false,
                };
                if !supported {
                    push(BaseDiagnosticSeverity::Error, Some(format!("{path}.op")),
                        format!("{context}: op `{}` is only valid for text fields, not `{field}`", op.as_str()));
                    return;
                }
            }
```

Extend the existing `contains` check to `matches!(op, Op::Contains | Op::NotContains)` (error message names the op via `op.as_str()`). `SysField::supports_relative_date`/`supports_affix` must be `pub(crate)`.

In `base_embed.rs`: `op_name(op)` becomes `op.as_str()` (delete the local table); `supports_operator` gains: relative ops → `supports_relative_date` of the resolved field; affix → `supports_affix`; `NotContains` → same as `Contains`. The valueless arm `Op::IsEmpty | Op::NotEmpty => …` becomes `op if op.is_valueless() => …`.

Add base.rs validation tests: `is_today` on a `select` property → one Error at `filter.op`; `is_today` with `value = "x"` → one Warning at `filter.value`; `starts_with` on `multi_select` → Error; `not_contains` on `number` → Error; all five relative ops on a `datetime` property and on `created_at` → no diagnostics.

- [ ] **Step 10: Thread `today` through member candidate matching (`src/vault/base_member.rs`) and the API**

Add a trailing `today: chrono::NaiveDate` parameter to `candidate_matches`, `composed_candidate_matches`, and `composed_candidate_matches_with_link_targets`; pass it into the in-memory matchers. `fixed_candidate_comparison_matches` (possibility analysis for blank-member creation) also receives `today`; a blank candidate's `created_at`/`updated_at` are "now", so `created_at is_today` is `AlwaysTrue` and `created_at is_next_week` is `AlwaysFalse` — let the existing fixed-field evaluation produce that by evaluating with the candidate's timestamps set to `today`; relative ops on declared properties stay `Maybe`. `implication_of` keeps returning `None` for the new ops.

Update every existing test call site in `base_member.rs` with a `fixed_today()` helper (`NaiveDate::from_ymd_opt(2026, 8, 9)`), and extend the parity test `composed_candidate_has_query_parity_for_every_supported_property_operator_pair` with rows for: `("date_value", IsToday|IsThisWeek|IsPastWeek|IsNextWeek|IsThisMonth, Null)`, `("text_value", NotContains|StartsWith|EndsWith, "Alph")`, `("select_value", NotContains, <an option>)`, `("multi_select_value", NotContains, <an option>)`, and confirm each in-memory verdict equals the SQL verdict with `today = fixed_today()`.

API: `src/api/base_members.rs:343` passes `state.clock.now().date_naive()`. `QueryContext::for_base(...)` at `src/api/bases.rs:408,630,695,742` and `src/api/properties.rs:480` become `QueryContext::for_base(&base).with_today(state.clock.now().date_naive())`; `src/api/query.rs:115` sets `today` the same way. The LSP call sites keep using `base_matches_meta` (wall-clock wrapper).

- [ ] **Step 11: Integration tests in `tests/bases_api.rs`**

Use `member_fixture` (it installs `FixedClock(2026-08-09T12:34:56Z)` → `today = 2026-08-09`, a **Sunday**; Monday of that week is `2026-08-03`). Seed in `pre_index_seed`: `bases/dates.base.toml` declaring `started = { type = "date" }`, `note = { type = "text" }`, `status = { type = "select" }`, base filter `kind eq BOOK`, and views:

```toml
[[views]]
name = "today"
filter = { field = "started", op = "is_today" }
columns = ["title", "started"]
[[views]]
name = "this-week"
filter = { field = "started", op = "is_this_week" }
[[views]]
name = "past-week"
filter = { field = "started", op = "is_past_week" }
[[views]]
name = "next-week"
filter = { field = "started", op = "is_next_week" }
[[views]]
name = "this-month"
filter = { field = "started", op = "is_this_month" }
[[views]]
name = "prefix"
filter = { field = "note", op = "starts_with", value = "ab" }
[[views]]
name = "no-reading"
filter = { field = "status", op = "not_contains", value = "reading" }
```

and pages under `books/`: `s1` started `2026-08-09`, note `"Abacus"`, status `reading`; `s2` started `2026-08-03`, note `"cab"`, status `queued`; `s3` started `2026-08-02`, note `"ABBEY"`; `s4` started `2026-08-12`; `s5` started `2026-07-31`; `s6` no `started`, no `status`. Assert via `GET /api/vault/bases/dates/views/{view}`:

- today → `{s1}`; this-week → `{s1, s2}`; past-week → `{s1, s2, s3}`; next-week → `{s4}`; this-month → `{s1, s2, s3, s4}`; prefix → `{s1, s3}` (case-insensitive); no-reading → `{s2, s3, s4, s5, s6}`.
- `POST /api/vault/bases/dates/views/today/evaluate` with body `{"filter": {"field": "status", "op": "not_contains", "value": "queued"}}` → `{s1}`.
- `POST /api/vault/bases/preview` with a definition whose filter is `{ field = "note", op = "is_today" }` → a diagnostic with `path == "filter.op"` and severity `error`; with `{ field = "started", op = "is_today", value = "x" }` → a `warning` at `filter.value`.
- Member creation: base filter `all = [kind eq BOOK, created_at is_today]` → `GET /api/vault/bases/{slug}` reports `member_creation[0].enabled == true`; creating a member succeeds (created_at is set from the fixed clock).

- [ ] **Step 12: Run everything, format, lint**

Run: `cargo test --lib vault::base vault::query vault::base_member vault::base_embed`, then `cargo test --test bases_api`, then `cargo fmt` and `cargo clippy --all-targets -- -D warnings`. Expected: all green.

- [ ] **Step 13: Commit**

```bash
git add src tests
git commit -m "feat(bases): relative-date and text filter operators

Adds is_today/is_this_week/is_past_week/is_next_week/is_this_month
(value-less, anchored on the request clock's UTC date, ISO Monday weeks,
rolling past/next windows) and not_contains/starts_with/ends_with.
SQL and in-memory evaluation stay in parity; validation and embed
validation gate the new operators by field type. TSK-0120"
```

---

### Task 2: Aggregates — new functions and flat-view totals

**Files:**
- Modify: `src/vault/base.rs` (`AggregateFn` ~line 190; aggregate validation ~line 1261)
- Modify: `src/vault/query.rs` (`QueryOutput::Flat` ~line 770; `evaluate_flat` ~line 879; `evaluate_grouped` ~line 902; `sql_aggregate` ~line 1050; tests)
- Modify: `src/api/bases.rs` only if a handler pattern-matches `QueryOutput::Flat { rows, total }` (search for `QueryOutput::Flat` across `src/` and `tests/` and add the new field)
- Test: `tests/bases_api.rs`

**Interfaces:**
- Produces: `AggregateFn::{CountEmpty, CountFilled, PercentFilled, CountUnique, Median, Range}`; `AggregateFn::requires_field(self)`; `AggregateFn::is_fold(self)`; `AggregateFn::as_str(self)`; `QueryOutput::Flat { rows, total, aggregates: Vec<serde_json::Value> }` (serialized as `"aggregates": [...]`, one entry per configured aggregate in order).
- Consumes: nothing from Task 1 (independent; both touch `base.rs`/`query.rs`, so run after Task 1 is committed).

- [ ] **Step 1: Failing unit tests in `src/vault/query.rs`**

Fixture: pages with `rating` (number) `5, 3, 4, (absent), 2, 3`, `status` (select) `reading, reading, queued, (absent), finished, reading`, `started` (date) `2026-08-01, 2026-08-11, (absent), (absent), 2026-08-21, 2026-08-31`, all `kind = BOOK`. Expected on the flat view with aggregates in this order:

| fn / field | expected |
| --- | --- |
| `count` | `6` |
| `count_filled(rating)` | `5` |
| `count_empty(rating)` | `1` |
| `percent_filled(rating)` | `83.3` |
| `count_unique(status)` | `3` |
| `median(rating)` | `3.0` (sorted 2,3,3,4,5 → 3) |
| `range(rating)` | `3.0` (5 − 2) |
| `median(started)` | `"2026-08-11"` (sorted 08-01, 08-11, 08-21, 08-31 → lower-middle of four is index 1) |
| `range(started)` | `30.0` (days between 08-01 and 08-31) |
| `sum(rating)` | `17.0` |

```rust
#[test]
fn flat_view_returns_aggregates_over_the_whole_predicate() {
    let (index, base) = aggregate_fixture();
    let spec = QuerySpec {
        filter: None, sort: vec![], group_by: None,
        aggregates: vec![
            agg(AggregateFn::Count, None),
            agg(AggregateFn::CountFilled, Some("rating")),
            agg(AggregateFn::CountEmpty, Some("rating")),
            agg(AggregateFn::PercentFilled, Some("rating")),
            agg(AggregateFn::CountUnique, Some("status")),
            agg(AggregateFn::Median, Some("rating")),
            agg(AggregateFn::Range, Some("rating")),
            agg(AggregateFn::Median, Some("started")),
            agg(AggregateFn::Range, Some("started")),
            agg(AggregateFn::Sum, Some("rating")),
        ],
        columns: vec![], limit: Some(2), offset: 1, group_row_limit: GroupRowLimit::Default,
    };
    let QueryOutput::Flat { rows, total, aggregates } =
        evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap()
    else { panic!("flat") };
    assert_eq!(rows.len(), 2, "window applies to rows");
    assert_eq!(total, 6);
    assert_eq!(aggregates, vec![
        json!(6), json!(5), json!(1), json!(83.3), json!(3), json!(3.0), json!(3.0),
        json!("2026-08-11"), json!(30.0), json!(17.0),
    ]);
}

#[test]
fn median_of_even_count_is_the_mean_of_the_middle_two() { /* ratings 1,2,3,4 → 2.5 */ }

#[test]
fn aggregates_over_an_empty_result_are_zero_or_null() {
    // filter matches nothing: count 0, count_filled 0, percent_filled 0, median null, range null, sum null
}

#[test]
fn grouped_views_support_the_new_functions() {
    // group_by status with [count_filled(rating), median(rating)] →
    // reading: (3, 3.0); queued: (1, 4.0); finished: (1, 2.0); null group: (0, null)
}

#[test]
fn aggregates_reject_multi_valued_system_fields_and_folds_on_text() {
    // count_unique(tags) → Err(InvalidAggregate(CountUnique)); median(status) → Err(InvalidAggregate(Median))
    // count_filled with no field → Err(InvalidAggregate(CountFilled))
}
```

- [ ] **Step 2: Run — expect compile failures**

Run: `cargo test --lib vault::query`

- [ ] **Step 3: Extend `AggregateFn` in `src/vault/base.rs`**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AggregateFn {
    Count,
    Sum,
    Avg,
    Min,
    Max,
    /// Rows where the field is absent.
    CountEmpty,
    /// Rows where the field is present.
    CountFilled,
    /// `100 * count_filled / count`, rounded to one decimal.
    PercentFilled,
    /// Distinct present values (first array element only).
    CountUnique,
    /// Middle value of the present values (mean of the two middles for numbers).
    Median,
    /// `max - min`; days for dates.
    Range,
}

impl AggregateFn {
    /// Every function but `count` folds a field.
    pub fn requires_field(self) -> bool {
        !matches!(self, AggregateFn::Count)
    }

    /// Numeric/temporal folds: need `number`, `date`, `datetime`, or `word_count`.
    pub fn is_fold(self) -> bool {
        matches!(
            self,
            AggregateFn::Sum | AggregateFn::Avg | AggregateFn::Min | AggregateFn::Max | AggregateFn::Median | AggregateFn::Range
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AggregateFn::Count => "count",
            AggregateFn::Sum => "sum",
            AggregateFn::Avg => "avg",
            AggregateFn::Min => "min",
            AggregateFn::Max => "max",
            AggregateFn::CountEmpty => "count_empty",
            AggregateFn::CountFilled => "count_filled",
            AggregateFn::PercentFilled => "percent_filled",
            AggregateFn::CountUnique => "count_unique",
            AggregateFn::Median => "median",
            AggregateFn::Range => "range",
        }
    }
}
```

Validation (base.rs ~line 1261): replace `!matches!(aggregate.function, AggregateFn::Count) && aggregate.field.is_none()` with `aggregate.function.requires_field() && aggregate.field.is_none()`. Add, when a field is present and resolves: fold on a declared property whose type is not `Number | Date | Datetime`, or on a system field other than `word_count` → Warning at `views[i].aggregates[j].field`: ``view `{}`: aggregate `{}` needs a number, date, or datetime field, not `{field}` ({ty:?})``; any function on `tags`/`aliases` → Warning ``view `{}`: aggregate `{}` cannot fold the multi-valued system field `{field}` ``. Use `function.as_str()` in messages. Add validation unit tests for both warnings and for `count_filled` on a `select` (no diagnostic).

- [ ] **Step 4: Implement `AggregatePlan` and flat aggregates in `src/vault/query.rs`**

```rust
/// One aggregate's SQL shape, shared by flat and grouped evaluation.
struct AggregatePlan {
    /// Select expressions appended after `COUNT(*)`; `None` for a median,
    /// which is computed from an ordered fetch.
    exprs: Vec<Option<String>>,
    /// `LEFT JOIN page_properties agg{i} … AND ord = 0` per property target.
    joins: String,
    params: Vec<SqlValue>,
    medians: Vec<MedianPlan>,
}

struct MedianPlan {
    /// Position in the aggregates list.
    index: usize,
    /// Column expression, e.g. `agg2.value_num` or `p.word_count`.
    column: String,
    /// The join that introduces `column` (empty for system columns), with its params.
    join: String,
    join_params: Vec<SqlValue>,
    numeric: bool,
}

enum AggregateTarget {
    Property { key: String, ty: PropertyType },
    System(&'static str, PropertyType),
}

fn plan_aggregates(spec: &QuerySpec, ctx: &QueryContext) -> Result<AggregatePlan, QueryError> {
    let mut plan = AggregatePlan { exprs: Vec::new(), joins: String::new(), params: Vec::new(), medians: Vec::new() };
    for (i, agg) in spec.aggregates.iter().enumerate() {
        let function = agg.function;
        if !function.requires_field() {
            plan.exprs.push(Some("COUNT(*)".to_string()));
            continue;
        }
        let Some(field) = agg.field.as_deref() else {
            return Err(QueryError::InvalidAggregate(function));
        };
        let target = match resolve_field(field, ctx)? {
            ResolvedField::Prop { key, ty } => AggregateTarget::Property { key, ty },
            ResolvedField::Sys(SysField::Tags | SysField::Aliases) => return Err(QueryError::InvalidAggregate(function)),
            ResolvedField::Sys(sys) => AggregateTarget::System(sys.column().expect("scalar"), sys.property_type()),
        };
        let (column, ty, join, join_params) = match target {
            AggregateTarget::Property { key, ty } => {
                let alias = format!("agg{i}");
                let join = format!(" LEFT JOIN page_properties {alias} ON {alias}.page_id = p.id AND {alias}.key = ? AND {alias}.ord = 0");
                (format!("{alias}.{}", typed_column(ty)), ty, join, vec![SqlValue::Text(key)])
            }
            AggregateTarget::System(column, ty) => (column.to_string(), ty, String::new(), Vec::new()),
        };
        if function.is_fold() && !matches!(ty, PropertyType::Number | PropertyType::Date | PropertyType::Datetime) {
            return Err(QueryError::InvalidAggregate(function));
        }
        plan.joins.push_str(&join);
        plan.params.extend(join_params.iter().cloned());
        let numeric = ty == PropertyType::Number;
        plan.exprs.push(match function {
            AggregateFn::Count => unreachable!("handled above"),
            AggregateFn::CountFilled => Some(format!("COUNT({column})")),
            AggregateFn::CountEmpty => Some(format!("COUNT(*) - COUNT({column})")),
            AggregateFn::PercentFilled => Some(format!("CASE WHEN COUNT(*) = 0 THEN 0 ELSE ROUND(100.0 * COUNT({column}) / COUNT(*), 1) END")),
            AggregateFn::CountUnique => Some(format!("COUNT(DISTINCT {column})")),
            AggregateFn::Sum | AggregateFn::Avg | AggregateFn::Min | AggregateFn::Max => Some(format!("{}({column})", sql_aggregate(function))),
            AggregateFn::Range if numeric => Some(format!("MAX({column}) - MIN({column})")),
            AggregateFn::Range => Some(format!("julianday(MAX({column})) - julianday(MIN({column}))")),
            AggregateFn::Median => {
                plan.medians.push(MedianPlan { index: i, column: column.clone(), join, join_params, numeric });
                None
            }
        });
    }
    Ok(plan)
}
```

`word_count` reaches this through `SysField::WordCount` (`p.word_count`, `PropertyType::Number`). `sql_aggregate` keeps only `Sum/Avg/Min/Max` (plus `Count`); make the other arms `unreachable!` with a message, or restrict its parameter — do not let it silently return `COUNT` for the new functions.

Header query for the flat case (replaces the `SELECT COUNT(*)` in `evaluate_flat`):

```rust
    let plan = plan_aggregates(spec, ctx)?;
    let header_sql = format!(
        "SELECT COUNT(*){} FROM pages p{} WHERE {}",
        plan.exprs.iter().flatten().map(|e| format!(", {e}")).collect::<String>(),
        plan.joins,
        prepared.where_clause,
    );
    // params: plan.params then prepared.where_params
    // read column 0 = total, then one column per Some(expr) in order; fill None slots from medians
    let mut aggregates = read_header_aggregates(&plan, row)?;  // Vec<serde_json::Value> with placeholders for medians
    for median in &plan.medians {
        aggregates[median.index] = median_value(conn, &prepared, median, None)?;
    }
    Ok(QueryOutput::Flat { rows, total, aggregates })
```

`median_value` runs `SELECT {column} FROM pages p{median.join}{group_join} WHERE {where} AND {group_predicate} AND {column} IS NOT NULL ORDER BY {column}` (the group join/predicate come from the same helper `fetch_rows` uses — refactor that predicate construction into a small `group_predicate(group: Option<(&GroupColumn, Option<&SqlValue>)>) -> (String /*join*/, String /*pred*/, Vec<SqlValue>)` so both call sites share it), collects the values, and returns: empty → `Null`; numeric → mean of the middle one/two as a JSON number; otherwise the lower-middle text as a JSON string.

`evaluate_grouped` replaces its inline aggregate loop with `plan_aggregates` and appends the medians per group after the header pass (one `median_value` call per group per median, `Some((&group_column, key.as_ref()))`).

Update every `QueryOutput::Flat { rows, total }` pattern/constructor across `src/` and `tests/` (search `QueryOutput::Flat`).

- [ ] **Step 5: Run unit tests — expect PASS**

Run: `cargo test --lib vault::query vault::base`

- [ ] **Step 6: Integration test in `tests/bases_api.rs`**

Reuse `READING_BASE`'s fixture pages (or seed six BOOK pages with ratings `5, 3, 4, absent, 2, 3`). Add a base `totals.base.toml` with a flat view:

```toml
[[views]]
name = "All"
columns = ["title", "rating"]
aggregates = [
  { fn = "count" },
  { fn = "count_filled", field = "rating" },
  { fn = "percent_filled", field = "rating" },
  { fn = "median", field = "rating" },
  { fn = "range", field = "rating" },
]
```

Assert `GET /api/vault/bases/totals/views/All?limit=2` returns `shape == "flat"`, two rows, `total == 6`, and `aggregates == [6, 5, 83.3, 3.0, 3.0]` — the window must not change the aggregates. Assert `POST /api/vault/bases/preview` with `{ fn = "median", field = "status" }` returns a `warning` diagnostic at `views[0].aggregates[0].field`. Assert the OpenAPI document (`ApiDoc::openapi()` is already imported in this file) lists `count_empty` … `range` in the `AggregateFn` enum and `aggregates` under the flat `QueryOutput` variant.

- [ ] **Step 7: Run everything, format, lint**

Run: `cargo test --test bases_api`, `cargo test --lib`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`. Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat(bases): flat-view aggregates and count/median/range functions

Flat query output now carries aggregates computed over the whole
predicate; adds count_empty, count_filled, percent_filled, count_unique,
median, and range with type gates shared by validation and evaluation.
TSK-0121"
```

---

### Task 3: Offline OpenAPI dump and schema regeneration

**Files:**
- Create: `examples/openapi.rs`
- Modify: `ui/package.json` (scripts)
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Produces: `cargo run -q --example openapi` prints the OpenAPI JSON; `bun run openapi:file` regenerates `schema.d.ts` from `../target/openapi.json`.
- Consumes: Tasks 1–2 (the enums and `QueryOutput` shape they added).

- [ ] **Step 1: Write the example**

```rust
//! Print the OpenAPI document without starting a server, so the UI's
//! `schema.d.ts` can be regenerated from a build of this exact checkout:
//!
//! ```sh
//! cargo run -q --example openapi > target/openapi.json && (cd ui && bun run openapi:file)
//! ```
use utoipa::OpenApi;

fn main() {
    let json = clepsydra::api::openapi::ApiDoc::openapi()
        .to_pretty_json()
        .expect("OpenAPI document serializes");
    println!("{json}");
}
```

- [ ] **Step 2: Add the script to `ui/package.json`** next to `"openapi"`:

```json
"openapi:file": "openapi-typescript ../target/openapi.json -o src/api/schema.d.ts",
```

- [ ] **Step 3: Regenerate and check the diff**

Run from the worktree root: `cargo run -q --example openapi > target/openapi.json && cd ui && bun run openapi:file && cd .. && git diff --stat ui/src/api/schema.d.ts`. Expected: `schema.d.ts` changes only in `Op`, `AggregateFn`, and `QueryOutput` (the flat variant gains `aggregates: unknown[]`) plus any ordering churn openapi-typescript produces. Run `cd ui && bun run typecheck` — expect errors only where Task 4/5 will add handling (e.g. exhaustive switches on `FilterOp`/`AggregateFunction`); list them in the report.

- [ ] **Step 4: Commit**

```bash
git add examples/openapi.rs ui/package.json ui/src/api/schema.d.ts
git commit -m "chore(openapi): offline dump example; regenerate schema for new ops and aggregates"
```

---

### Task 4: UI — operators in the filter editor, embed inspector, and embed validation

**Files:**
- Modify: `ui/src/components/bases/definition-model.ts` (`operatorsFor` only — Task 5 owns `AggregateFunction`/`aggregateFunctions` in the same file; re-read before editing)
- Modify: `ui/src/components/bases/FilterComparisonEditor.tsx` (`VALUELESS_OPERATORS`, operator labels)
- Modify: `ui/src/editor/convert/baseEmbedMarkdown.ts` (`VALUELESS_OPERATORS`, `FILTER_OPERATORS`)
- Modify: `ui/src/components/bases/embed-semantic-validation.ts` (`MULTI_SYSTEM_OPERATORS`, `supportsOperator`, valueless check)
- Test: `ui/src/components/bases/__tests__/definition-model.test.ts` (create if absent), `__tests__/FilterComparisonEditor.test.tsx` (extend or create), `ui/src/editor/convert/__tests__/baseEmbedMarkdown.test.ts`, `ui/src/components/bases/__tests__/embed-semantic-validation.test.ts` (extend or create)

**Interfaces:**
- Consumes: `FilterOp` from `#/api/bases` (schema-derived; now includes the new names).
- Produces: `operatorsFor(type)` returns the extended sets below; the filter editor emits `{ field, op }` (no `value`) for every valueless op.

- [ ] **Step 1: Failing tests**

`definition-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { operatorsFor } from "../definition-model";

describe("operatorsFor", () => {
  it("offers relative-date operators for date-like fields", () => {
    for (const type of ["date", "datetime"] as const) {
      expect(operatorsFor(type)).toEqual([
        "eq", "ne", "lt", "lte", "gt", "gte",
        "is_today", "is_this_week", "is_past_week", "is_next_week", "is_this_month",
        "is_empty", "not_empty",
      ]);
    }
  });
  it("offers affix and negated contains on substring fields", () => {
    for (const type of ["text", "url", "system-scalar"] as const) {
      expect(operatorsFor(type)).toEqual([
        "eq", "ne", "contains", "not_contains", "starts_with", "ends_with", "in", "is_empty", "not_empty",
      ]);
    }
  });
  it("offers not_contains but no affix on membership fields", () => {
    expect(operatorsFor("select")).toEqual(["eq", "ne", "contains", "not_contains", "in", "is_empty", "not_empty"]);
    expect(operatorsFor("multi_select")).toEqual(["eq", "ne", "contains", "not_contains", "in", "is_empty", "not_empty"]);
    expect(operatorsFor("system-multi")).toEqual(["contains", "not_contains", "in", "is_empty", "not_empty"]);
    expect(operatorsFor("number")).toEqual(["eq", "ne", "lt", "lte", "gt", "gte"]);
    expect(operatorsFor("relation")).toEqual(["eq", "ne", "links_to", "is_empty", "not_empty"]);
    expect(operatorsFor("bool")).toEqual(["eq", "ne", "in", "is_empty", "not_empty"]);
  });
});
```

`FilterComparisonEditor.test.tsx`: render the editor for a `date` property comparison `{ field: "started", op: "eq", value: "2026-08-01" }`, change the operator select to `is_today` (label "is today"), assert `onChange` was called with `{ field: "started", op: "is_today" }` (no `value` key) and that no value input is rendered; change to `starts_with` on a text field and assert the text input remains.

`baseEmbedMarkdown.test.ts`: a fence with `filter = { field = "started", op = "is_this_week" }` parses to a configured element and serializes back byte-identically; `filter = { field = "started", op = "is_today", value = "x" }` fails with a message containing "does not accept a value"; `op = "starts_with"` with a string value parses.

`embed-semantic-validation.test.ts`: `is_today` on a `select` property → diagnostic at `filter.op` naming the op; `starts_with` on `tags` → diagnostic; `not_contains` on `tags` → no diagnostic; `is_this_month` on `created_at` and on a `datetime` property → no diagnostic; `journal_date is_today` → no diagnostic.

- [ ] **Step 2: Run — expect failures**

Run from `ui/`: `bun run test definition-model FilterComparisonEditor baseEmbedMarkdown embed-semantic-validation`

- [ ] **Step 3: Implement**

`definition-model.ts`:

```ts
const RELATIVE_DATE_OPERATORS: readonly FilterOp[] = [
  "is_today", "is_this_week", "is_past_week", "is_next_week", "is_this_month",
];

export function operatorsFor(type: PropertyType | "system-multi" | "system-scalar"): FilterOp[] {
  switch (type) {
    case "system-multi":
      return ["contains", "not_contains", "in", "is_empty", "not_empty"];
    case "multi_select":
    case "select":
      return ["eq", "ne", "contains", "not_contains", "in", "is_empty", "not_empty"];
    case "number":
      return ["eq", "ne", "lt", "lte", "gt", "gte"];
    case "date":
    case "datetime":
      return ["eq", "ne", "lt", "lte", "gt", "gte", ...RELATIVE_DATE_OPERATORS, "is_empty", "not_empty"];
    case "relation":
      return ["eq", "ne", "links_to", "is_empty", "not_empty"];
    case "bool":
      return ["eq", "ne", "in", "is_empty", "not_empty"];
    case "text":
    case "url":
    case "system-scalar":
      return ["eq", "ne", "contains", "not_contains", "starts_with", "ends_with", "in", "is_empty", "not_empty"];
  }
}
```

`FilterComparisonEditor.tsx`: extend `VALUELESS_OPERATORS` with the five relative ops. Find where operator options get their display text (search the file for the operator `<select>`/`Select` and how `eq` is labelled); add labels: `not_contains` → "does not contain", `starts_with` → "starts with", `ends_with` → "ends with", `is_today` → "is today", `is_this_week` → "is this week", `is_past_week` → "is in the past week", `is_next_week` → "is in the next week", `is_this_month` → "is this month". If the file renders raw op names today, add a `OPERATOR_LABELS: Record<FilterOp, string>` covering every op (existing ones: `eq` "is", `ne` "is not", `lt` "<", `lte` "≤", `gt` ">", `gte` "≥", `contains` "contains", `in` "is any of", `links_to` "links to", `is_empty` "is empty", `not_empty` "is not empty") and use it for the option text only — never for the wire value.

`baseEmbedMarkdown.ts`: add the five relative ops to `VALUELESS_OPERATORS` and all eight new ops to `FILTER_OPERATORS`. The valueless check must produce the existing "does not accept a value" message for them.

`embed-semantic-validation.ts`: add `not_contains` to `MULTI_SYSTEM_OPERATORS`; in `supportsOperator` mirror the server: relative ops → field type `date`/`datetime` (declared) or system `created_at`/`updated_at`/`journal_date`; `starts_with`/`ends_with` → declared `text`/`url` or system scalars whose type is text (`id`, `path`, `title`, `kind`, `project`, `created_at`, `updated_at`); `not_contains` wherever `contains` is accepted. Extend the valueless check `filter.op === "is_empty" || filter.op === "not_empty"` to a `VALUELESS_OPERATORS` set including the relative ops.

- [ ] **Step 4: Run tests, typecheck, scoped lint**

From `ui/`: `bun run test definition-model FilterComparisonEditor baseEmbedMarkdown embed-semantic-validation tag-condition TagConditionEditor BaseFilterEditor BaseEmbedInspector`, then `bun run typecheck`, then `bunx biome check --write <touched files>`. Expected: green; `tag-condition` suites unchanged (a `not_contains` on tags must fall through to the general condition row, not the tag row).

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(bases-ui): relative-date and text operators in filter editors and embed validation"
```

---

### Task 5: UI — aggregate functions and the flat-view footer

**Files:**
- Modify: `ui/src/components/bases/definition-model.ts` (`AggregateFunction`, `aggregateFunctions` only — Task 4 owns `operatorsFor`; re-read before editing)
- Modify: `ui/src/components/bases/ViewDefinitionEditor.tsx:64-70` (`AGGREGATE_FUNCTION_OPTIONS`)
- Modify: `ui/src/components/bases/BaseTableView.tsx` (extract `AggregateChips`; render a footer for flat output)
- Modify: `ui/src/api/bases.ts` (`mergeWindows` ~line 275)
- Test: `ui/src/components/bases/__tests__/BaseTableView.test.tsx`, `ui/src/api/__tests__/baseViewWindows.test.ts`, `ui/src/components/bases/__tests__/definition-model.test.ts` (created in Task 4 — append), `__tests__/ViewDefinitionEditor.test.tsx` if it exists

**Interfaces:**
- Consumes: `QueryOutput` flat variant now has `aggregates: unknown[]`; `Aggregate["fn"]` union from the schema.
- Produces: `export type AggregateFunction = Aggregate["fn"]`; `aggregateFunctions(type)`: number/date/datetime/word_count → all eleven in the order `count, count_filled, count_empty, percent_filled, count_unique, sum, avg, min, max, median, range`; any other declared type → `count, count_filled, count_empty, percent_filled, count_unique`; `undefined` (no field) → `["count"]`.

- [ ] **Step 1: Failing tests**

`definition-model.test.ts` (append):

```ts
describe("aggregateFunctions", () => {
  it("offers every function on numeric and temporal fields", () => {
    for (const type of ["number", "date", "datetime", "word_count"] as const) {
      expect(aggregateFunctions(type)).toEqual([
        "count", "count_filled", "count_empty", "percent_filled", "count_unique",
        "sum", "avg", "min", "max", "median", "range",
      ]);
    }
  });
  it("offers only the count family elsewhere", () => {
    expect(aggregateFunctions("select")).toEqual(["count", "count_filled", "count_empty", "percent_filled", "count_unique"]);
    expect(aggregateFunctions(undefined)).toEqual(["count"]);
  });
});
```

`BaseTableView.test.tsx`: render a flat output `{ shape: "flat", rows: [...two rows...], total: 2, aggregates: [2, 50] }` for a view whose `aggregates` are `[{ fn: "count" }, { fn: "percent_filled", field: "rating" }]`; assert a `role="contentinfo"`-free footer with accessible name "Totals" (`<footer aria-label="Totals">`) contains chips "count 2" and "percent_filled(rating) 50"; assert no footer renders when the view has no aggregates; assert grouped output still renders chips in group headers (existing behaviour) and no footer.

`baseViewWindows.test.ts`: two flat windows whose newest carries `aggregates: [7]` → merged `data.output.aggregates` equals `[7]`.

- [ ] **Step 2: Run — expect failures**

From `ui/`: `bun run test definition-model BaseTableView baseViewWindows`

- [ ] **Step 3: Implement**

`definition-model.ts`:

```ts
export type AggregateFunction = Aggregate["fn"];

const COUNT_FAMILY: readonly AggregateFunction[] = [
  "count", "count_filled", "count_empty", "percent_filled", "count_unique",
];
const FOLD_FAMILY: readonly AggregateFunction[] = ["sum", "avg", "min", "max", "median", "range"];

export function aggregateFunctions(type: PropertyType | "word_count" | undefined): AggregateFunction[] {
  if (type === undefined) return ["count"];
  if (type === "number" || type === "date" || type === "datetime" || type === "word_count") {
    return [...COUNT_FAMILY, ...FOLD_FAMILY];
  }
  return [...COUNT_FAMILY];
}
```

`ViewDefinitionEditor.tsx`: `AGGREGATE_FUNCTION_OPTIONS` lists all eleven in the same order; keep the `satisfies readonly AggregateFunction[]`. Check the field-select logic around lines 589-631: when the chosen function `requires a field` (everything but `count`) the field select must be enabled and required; when switching to `count` it may clear the field. Keep the existing behaviour for `sum`…`max` and extend the "needs a field" predicate to `fn !== "count"`.

`BaseTableView.tsx`: extract the group-header chip loop (lines ~1057-1072) into

```tsx
function AggregateChips({ values, definition, viewName, rows }: {
  values: readonly unknown[];
  definition: BaseDetailResponse;
  viewName: string;
  rows: readonly { id: string }[]; // displayAggregateRows for stable keys
}) { /* same markup as today: one bordered cl-mono chip per value, `${label} ${formatCellValue(value)}` */ }
```

and use it in the group header. For `output.shape === "flat"` and `view.aggregates.length > 0`, render after the grid (outside the compact `ScrollViewport` so it stays visible while the embed scrolls):

```tsx
<footer aria-label="Totals" className="mt-1 flex flex-wrap items-baseline gap-2 border-t border-rule pt-1">
  <span className="cl-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">Totals</span>
  <AggregateChips values={output.aggregates} … />
</footer>
```

`ui/src/api/bases.ts` `mergeWindows`: `output: { shape: "flat", rows, total: newest.output.total, aggregates: newest.output.aggregates }`.

- [ ] **Step 4: Run tests, typecheck, scoped lint**

From `ui/`: `bun run test bases baseViewWindows definition-model ViewDefinitionEditor BaseTableView EmbeddedBaseTable BaseEmbedElement`, `bun run typecheck`, `bunx biome check --write <touched files>`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(bases-ui): flat-view totals footer and count/median/range aggregate functions"
```

---

### Task 6: Documentation

**Files:**
- Modify: `ui/src/docs/content/bases.mdx` (operator table ~line 189; new subsection after "Boolean filters"; aggregates paragraph ~line 327; Web UI paragraph ~line 344)

**Interfaces:** none.

- [ ] **Step 1: Operator table** — add rows after `contains`:

```md
| `not_contains` | Negation of `contains`: no substring match on text, no element equals the value on multi-valued fields. Missing properties also match. |
| `starts_with`, `ends_with` | Prefix and suffix match on `text` and `url` properties and text system fields (`title`, `path`, `kind`, `project`, `id`, `created_at`, `updated_at`). ASCII case-insensitive, like `contains`. Not valid on `select`, `multi_select`, `relation`, `tags`, or `aliases`. |
| `is_today`, `is_this_week`, `is_past_week`, `is_next_week`, `is_this_month` | Relative-date predicates on `date` and `datetime` properties and on `created_at`, `updated_at`, and `journal_date`. Omit `value`. See [Relative dates](#relative-dates). |
```

- [ ] **Step 2: New subsection `### Relative dates`** after "Boolean filters":

```md
### Relative dates

A relative-date operator compares the stored value's calendar date — the `YYYY-MM-DD` part of the TOML date or date-time, as written — against the day the query runs. "Today" is the server clock's UTC date, the same day Agenda and Journal use. Windows are:

| Operator | Matches |
| --- | --- |
| `is_today` | today |
| `is_this_week` | Monday through Sunday of the current ISO week |
| `is_past_week` | the last seven days, including today |
| `is_next_week` | the next seven days, excluding today |
| `is_this_month` | the first through the last day of the current month |

```toml
[[views]]
name = "Due soon"
filter = { field = "due", op = "is_next_week" }
```

The value is never converted between time zones: `2026-08-28T23:30:00-05:00` is 28 August. A saved view with a relative filter re-evaluates every time it is opened, so its rows change from day to day without editing the base.
```

- [ ] **Step 3: Aggregates paragraph** — replace the sentence starting "The shipped aggregate functions are" with:

```md
The aggregate functions are:

| Function | Field | Result |
| --- | --- | --- |
| `count` | none | number of rows |
| `count_filled`, `count_empty` | any declared property or scalar system field | rows where the field is present / absent |
| `percent_filled` | same | `100 × count_filled ÷ count`, one decimal |
| `count_unique` | same | distinct present values (the first element of an array) |
| `sum`, `avg`, `min`, `max` | `number`, `date`, `datetime`, or `word_count` | the usual folds |
| `median` | same | the middle value; the mean of the two middle values for numbers |
| `range` | same | `max − min`; for dates, the number of days between them |

`tags` and `aliases` cannot be aggregated. Aggregates are computed over the whole result — a `limit` or scroll window never changes them. A grouped view returns one set per group; a flat view returns one set for the view, shown as a totals row beneath the table. For example:
```

- [ ] **Step 4: Web UI paragraph** — after "shows group counts and aggregate values," insert "renders a flat view's aggregates as a **Totals** row beneath the table,".

- [ ] **Step 5: Verify the docs build and commit**

From `ui/`: `bun run typecheck` (MDX is type-checked through the docs loader) and `bun run test docs` if a docs suite exists. Commit:

```bash
git add ui/src/docs/content/bases.mdx
git commit -m "docs(bases): relative-date and text operators; aggregate functions and totals row"
```

---

### Task 7: Gates and hand-off (controller)

- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (full), from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test` (full; the two `Sheaf.test.tsx` failures pre-date this branch — confirm the count is unchanged and nothing else fails).
- [ ] Final whole-branch review (superpowers:requesting-code-review), one fix wave if needed.
- [ ] Merge `feature/bases-query-operators` into `develop` with `--no-ff`; remove the worktree.
- [ ] Update the task cards TSK-0120 and TSK-0121 (checklist items, status → Review) and the "Bases vs OpenBook: gap analysis" note.
