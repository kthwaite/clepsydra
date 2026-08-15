## Task 2 report: comment-preserving presentation metadata persistence

### Status

Implemented managed root `preview` persistence and verified that per-view `labels` continue to merge through the existing named-view `ViewOrigin` mapping. No model or API semantics changed.

### RED evidence

Command:

```text
cargo test vault::base_document::tests -- --nocapture
```

Observed before production changes:

```text
running 34 tests
vault::base_document::tests::preview_updates_preserve_root_comments_unknown_keys_and_order ... FAILED
test result: FAILED. 33 passed; 1 failed; 0 ignored; 0 measured; 1043 filtered out
```

The failure was the expected missing behavior: after an update, the raw document still contained only the owner comment, name, unknown `plugin_key`, and properties; no `preview` entry was persisted. A narrowed rerun confirmed the same cause:

```text
cargo test vault::base_document::tests::preview_updates_preserve_root_comments_unknown_keys_and_order -- --nocapture
running 1 test
assertion failed: added.contains(r#"field = "body""#)
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 1076 filtered out
```

The other new tests passed during RED because Task 1 had already enabled canonical new-file serialization and the existing named-view structural merge already safely handled `labels`; the missing managed root `preview` mutation was the sole failing production contract.

### GREEN evidence

Final focused command:

```text
cargo test vault::base_document::tests -- --nocapture
```

Final output:

```text
cargo test: 35 passed (53 suites, 1922 filtered, 0.00s)
```

No formatter, linter, build, or project-wide suite was run, as required by the task brief.

### Changed files

- `src/vault/base_document.rs`
  - Added `preview` to the root managed-key set.
  - Added field-identity-aware preview-array structural merging so additions, edits, reorderings, and removals retain safely addressable raw nodes and their formatting.
  - Reused existing named-view merging for `views.labels` without replacing whole view tables.
  - Added focused persistence, mapping, revision, and removal-safeguard tests.
- `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-2-report.md`
  - Recorded RED/GREEN and review evidence.

### Preservation evidence

- `create_serializes_ordered_preview_entries_and_view_labels` proves ordered preview serialization, stable sorted labels, and exact raw-byte revision.
- `preview_updates_preserve_root_comments_unknown_keys_and_order` exercises add, label edit, reorder, row removal, and final-node removal while preserving the root comment and unknown `plugin_key`; returned revisions equal BLAKE3 of each written raw document.
- `view_label_updates_preserve_view_comments_and_unknown_keys` exercises add, edit, and final-node removal while retaining the named view's comment and unknown `plugin_view`; returned revisions match exact written bytes.
- `reordered_and_renamed_view_label_edits_follow_view_origins` proves label changes stay with the supplied logical origins after reorder and rename, including each view's comment and unknown key.
- `commented_presentation_node_removal_is_rejected_without_touching_bytes` proves comment-bearing preview and labels nodes retain the existing removal safeguards and exact bytes.
- `stale_presentation_update_preserves_exact_bytes` proves stale preview/labels writes conflict before publication and leave bytes unchanged.

### Self-review

Reviewed the complete diff against the brief. Preview reorder mapping is local to preview entries and uses their existing `field` identity; unmatched removed entries still pass through `ensure_value_removable`, mapped entries use the existing recursive merge primitives, and outer array decor/trailing syntax is retained. Labels remain inside the existing named-view merge path and therefore continue to use validated `ViewOrigin` identities. No obsolete path, model change, API change, suppression, or weakened comment/unknown-key removal guard was introduced. Focused tests are deterministic filesystem tests using real serialization and update paths. No concerns remain.
