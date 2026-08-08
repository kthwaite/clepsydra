# Final feed-tag cache fix report

## Status

Complete. Feed-owned tags and editable entry-owned tags now remain distinct from the backend response through optimistic UI cache filtering.

## Changes

- Added `feed_tags` to backend entry output and populated it by decoding the joined feed's `f.tags` JSON.
- Added `feed_tags` to the UI `Entry` contract and test fixtures.
- Updated tag-filter membership to retain entries matching either `tags` or `feed_tags` without merging the two arrays.
- Left entry patching and `TagEditor` behavior entry-owned: only `entry.tags` is editable and sent in tag PATCH requests.
- Added cache regressions for feed-derived matches across read, bookmark, and entry-tag patches, plus removal after the last entry-owned match disappears while feed tags do not match.
- Restored the missing trailing newline in `task-3-report.md`.

## Self-review

Reviewed the backend select/projection, serialized output fields, UI model, optimistic patch construction, filter predicate, fixtures, and focused regression assertions. The inherited array is used only for filter membership; patches continue to replace only `tags`. No unrelated production behavior was changed.

## Validation

Validation is intentionally deferred to the parent agent. Per task constraints, no formatter, linter, build, test, package, or typecheck command was run in this fix.

## Concerns

None identified in the scoped change. Parent validation must confirm Rust formatting and the focused UI regressions.
