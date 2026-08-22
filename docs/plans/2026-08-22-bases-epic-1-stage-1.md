# Bases Epic 1 (TSK-0065) — Stage 1: tag conditions and filter authoring

Status: stage 1 delivered 2026-08-22 on `feature/bases-tag-conditions`,
merged to develop. Stage 2 remains open under TSK-0065.

## Standing scope correction

TSK-0085 (sealed 2026-08-15) already delivered four of the epic's nine checks:
per-view display labels with stable field references including `body`, and the
preview projection with its compact render, conflict and missing-value
behaviour. `bases.mdx` documents both. The live remainder is compound-filter
authoring, tag conditions, the button/affordance pass, and shared accessible
ordering.

## Stage split

- **Stage 1 (this plan)** — tag conditions, compound-filter authoring, the
  button pass over the filter surfaces, and the tag-filter documentation.
- **Stage 2** — the button pass over the rest of the Bases workspace
  (Properties, Views, Preview, definition header) and one shared accessible
  ordering interaction adopted by sorts and filter children.

## Serialization contract

The engine already expresses every tag predicate (`src/vault/base.rs:601-620`):
on a multi-valued field `contains`/`eq` is membership of one value and `in` is
"any of". So:

| Quantifier | Canonical AST |
| --- | --- |
| has all of | `{all:[{tags contains a},{tags contains b}]}`, single value → the bare comparison |
| has any of | `{field:"tags",op:"in",value:[a,b]}` |
| has none of | `{not: <the any-of encoding>}` |

The reader also recognises the equivalent `any`-group encoding and a bare `eq`,
and each recognised condition remembers the encoding it came from, so opening
and saving a base never rewrites a filter the user did not touch.

## Tasks

Each task is red-first: write the failing test, then the implementation.

1. **Tag-condition model** — `tag-condition.ts` with `readTagCondition` and
   `writeTagCondition`. Tests: every recognised encoding, `not` wrapping,
   rejection of mixed-field groups, nested groups and unsupported ops,
   encoding-preserving round trips, canonical output for fresh conditions,
   empty-value handling.
2. **TagConditionEditor** — field select (Tags/Aliases), quantifier select,
   `TagInput` chips fed by `useTags()`, diagnostics for the row and the nodes it
   subsumes, remove, and an escape hatch to the advanced condition row.
3. **FilterGroupEditor dispatch** — recognise a tag condition before the
   comparison branch; choosing Tags in a generic row converts it to a tag row.
4. **Filter-surface button pass** — replace the per-level button walls in
   `MembershipEditor` and `FilterGroupEditor` with one Add menu plus a row
   overflow menu, carrying disabled reasons.
5. **Docs and gates** — a compound-tag-filter section in `bases.mdx`; then
   typecheck, lint against baseline, and the full ui and cargo suites.

## Delivered

- `tag-condition.ts` + `TagConditionEditor` + the `FilterGroupEditor` dispatch
  (47 tests across the model, the row, and membership authoring).
- `filter-actions.tsx`: `FilterSeedMenu` and `FilterNodeMenu` replace the
  button walls in `MembershipEditor` and `FilterGroupEditor`.
- `bases.mdx` gains a "Tag conditions" section.

## Acceptance for stage 1

A tag predicate can be authored without hand-nesting groups, serializes to the
existing AST, round-trips without rewriting untouched filters, stays
keyboard-operable with diagnostics attached to the control at fault, and the
filter surfaces present one coherent button hierarchy.
