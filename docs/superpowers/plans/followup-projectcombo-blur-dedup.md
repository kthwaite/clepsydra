# Follow-up: harden ProjectCombo against a hypothetical double-blur

**Status:** backlog (logged 2026-06-01 during §7 Plan 4 final review)

## Problem

`ui/src/components/codex/ProjectCombo.tsx` de-dupes the assign mutation with a
`justSelectedRef` flag: `onSelectionChange` (list pick) and `commit()` (Enter /
blur) both set the ref so the *one* trailing blur after a commit is swallowed.
This correctly prevents the Enter→blur and pick→blur double-fire that real
react-aria emits.

The final Plan 4 review raised a speculative residual: if react-aria were to
emit **two** blur events for a single focus-loss (e.g. popover close + input
blur in some version), the second `commit()` would see the ref already reset to
`false` and could fire a second `onAssign(slug)` while the first mutation is
still in flight. In FOLIO (`value` = current project) this races; in GAZETTEER
the `bulk.isPending` early-return absorbs it.

Impact is low: the assign endpoint is idempotent (reconcile is idempotent, a
re-assign to the same kind/project is a no-op move), and FOLIO remounts the
ProjectCombo via `key={project ?? ""}` after the value settles. No data loss.

**Do NOT** "fix" this by removing `justSelectedRef.current = true` from
`commit()` — that was the reviewer's suggestion but it reintroduces the genuine
Enter→blur double-fire that Plan 4 Task 6 deliberately closed.

## Proposed

If a real double-blur is ever observed, replace the boolean ref with a
last-committed-slug guard: track the slug most recently sent to `onAssign` and
suppress any `commit()` whose `draft` equals it until the input value changes
again. That guards every redundant path without depending on event ordering.

## Acceptance

Rapid pick/Enter/blur sequences in FOLIO fire exactly one `assign.mutate` per
intentional commit, with no dependence on how many blur events react-aria emits.
