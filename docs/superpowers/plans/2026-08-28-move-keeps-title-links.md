# Moves keep `[[Title]]` wikilinks (TSK-0119)

Branch `fix/move-title-links` in `.worktrees/link-rewrite`, off `develop`.

## Bug

Moving a page (explicit move, `vault_assign` relocation, folder move) rewrote
every `[[<title>]]` wikilink in backlinking pages to `[[<new filename stem>]]`
— even when the title was unchanged and the link would have kept resolving.
On 2026-08-28 one relocation turned `[[Clepsydra]]` into
`[[20260812.clepsydra.zxKjGxHr]]` in 23 pages, two of them human journals.

## Why the rewrite was wrong

A page resolves under several canonical names (`derivers/canonical_names.rs`):
title, filename, full path stem, and each alias. A move changes only the
filename/path-derived names. `[[Title]]` and `[[alias]]` links resolve through
names the move does not touch, so rewriting them is pure damage. `[[old-stem]]`
and relative Markdown links do break, and those rewrites stay.

## Decision

- `plan_page_move` and `plan_folder_move` drop the `(title → new_stem)`
  replacement. Stem-form and relative-path rewrites are unchanged.
- `plan_page_delete` is unchanged: every link to a deleted page breaks, so
  turning `[[Title]]` into plain text there is correct.
- A title *change* is not a move and is out of scope (nothing rewrites
  `[[Old Title]]` today; separate feature if wanted).
- No API/DTO change; no UI change; no docs claim title rewriting, so none to fix.

## Tasks (TDD)

1. RED — `tests/mutation_test.rs`:
   - `plan_page_move_keeps_title_links_when_stem_unchanged` (ADR-0002 name
     moved between folders; referrer with `[[Clepsydra]]` and
     `[[Clepsydra|alias text]]` → no staged write, no text edit).
   - `plan_page_move_rewrites_stem_links_but_keeps_title_links`
     (`target.md` → `renamed.md`; `[[Target]]` kept, `[[target]]` → `[[renamed]]`).
   - `plan_folder_move_keeps_title_links`.
   Correct `tests/api_test.rs::move_page_rewrites_backlinks` to assert the
   title link survives, the stem link is rewritten, and `GET /index/backlinks`
   on the new path still lists the referrer.
2. GREEN — remove the two title-replacement blocks in `src/vault/mutation.rs`
   (~677 and ~964); leave a comment naming the canonical-name reason.
3. Gates: `cargo test --test mutation_test --test api_test --test index_handle_test`,
   `cargo clippy --all-targets -- -D warnings`, `rustfmt --check` on touched files.
4. Merge into develop through a temporary worktree; reinstall `clep`.
