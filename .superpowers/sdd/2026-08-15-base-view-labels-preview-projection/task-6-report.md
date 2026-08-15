# Task 6 Report: Bases presentation documentation

## Status

DONE

## Files changed

- `ui/src/docs/content/bases.mdx`
  - Corrected the Configure workspace to five sections and documented **Preview properties** plus per-view display labels.
  - Added exact root `preview` and per-view `labels` TOML, including an omitted optional preview label.
  - Documented canonical field identity, system/property qualification, custom keys beginning with reserved prefixes, read-only `body`, independent table columns and generic page projections, deterministic multi-Base merge order, canonical de-duplication, label and schema conflicts, missing values, the four-field cap, protected-page suppression, explicit Save/Discard, stale revision conflicts, and manual-file safety.
- `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-6-report.md`
  - Recorded contract cross-checks, focused verification, and review.

No test file changed. Review found no uncovered observable boundary: the existing Task 1–5 regressions already cover model validation and identity, persistence and stale revisions, API merge/conflict/missing/cap/protected behavior, Base table label rendering with stable keys, authoring Save/Discard/conflict behavior, and shared link/tab projection rendering.

## Contract cross-check

The documentation was checked against the final code at `bc29140b` and the generated/UI boundaries rather than the earlier task prose:

- `ui/src/api/schema.d.ts` exposes optional `BaseFilePayload.preview`, required `PreviewFieldDefinition.field`, optional `PreviewFieldDefinition.label`, and optional `ViewDefinition.labels` as a string map.
- `BaseDefinitionWorkspace` renders the ordered sections **General**, **Filter**, **Properties**, **Preview properties**, and **Views**.
- `BaseTableView` resolves the active view's labels through canonical presentation identity while keeping the configured column string as the table, sort, query, and edit key.
- The backend resolver treats bare system names system-first, preserves custom shadows through `prop.`, and requires another `prop.` layer for custom keys that begin with `prop.` or `sys.`. The merged page projection sorts matching Bases by slug, retains configured row order within each Base, de-duplicates by canonical identity at first position, and returns the first four fields plus the exact remainder.
- `PreviewBody` renders missing values as `—`, label conflict as `!`, schema conflict as `≠`, body across a clamped two-line row, and `+N more`; it suppresses the entire projection region for protected pages.
- The backend treats an empty normalized body excerpt as missing and keeps schema-conflicted custom values readable in the read-only projection.

The TOML examples keep root `preview` before child tables and put `labels` inside its `[[views]]` entry. Dotted label keys are quoted where demonstrated.

## Focused documentation verification

The MDX change adds and edits prose plus fenced TOML only. It changes no imports or components, so the Task 6 brief explicitly requires no documentation build, UI typecheck, or synthetic prose test. No project-wide command was run.

Focused whitespace verification:

```text
git diff --check -- ui/src/docs/content/bases.mdx .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-6-report.md
# exit 0; no output
```

## Self-review

- Checked every named behavior in the brief against current generated types, backend merge/projection code, and rendered UI code.
- Kept saved table labels and generic page previews explicitly independent.
- Distinguished presentation labels from stable page-frontmatter, column, query, sort, and edit identities.
- Described protected generic projection suppression without contradicting the existing fact that protected-page frontmatter can still participate in Base membership and saved tables.
- Added no speculative API, compatibility alias, test of source text, or unrelated documentation change.

## Concerns

None.
