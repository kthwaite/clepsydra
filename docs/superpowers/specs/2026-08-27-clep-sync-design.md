# clep sync — Git-backed vault synchronisation (spec)

Settled by design interview 2026-08-27. Decisions of record: `docs/adr/0003`
(hybrid petname codes), `docs/adr/0004` (Conflict Copies), `docs/adr/0005`
(CAS in-vault, frontmatter blob metadata). Vault note: "Clep Sync Git
Feasibility Evaluation". Task: TSK-0083. Glossary terms **Code** and
**Conflict Copy** are in `CONTEXT.md`.

Clepsydra is a single-user app. Sync coordinates one user's devices, never
concurrent users.

## 1. Codes (ADR 0003)

- Mint format: `TSK-<adjective>-<noun>-<tail>`, Cycles `S-<adjective>-<noun>-<tail>`.
  Words from two frozen, vendored 512-word lists (short, common, hand-screened;
  may grow, never shrink or reorder). Tail: 5 lowercase Crockford base32 chars
  (alphabet excludes `i l o u`). Everything after the prefix is lowercase ASCII
  plus hyphens. 43 bits total.
- Local mint re-rolls if the code already exists in the index. The
  `code_counters` table and `reserve_next_code_number` path are deleted.
- Addressing: full code canonical; any unique prefix (e.g. `TSK-brave-finch`)
  resolves; ambiguous prefix is an error listing candidates.
- Migration (one-time, clean break): rename every existing sequential-coded
  Task/Cycle file to a newly minted code; rewrite wikilinks via the normal
  move machinery; rewrite plain-text `TSK-\d{4}` and `S-\d+` tokens across all
  page bodies. No legacy alias map afterward.

## 2. Repository & `clep sync init`

- Vault root = git repo root. Refuse (clear error) if the vault root sits
  inside an outer repo.
- `clep sync init [--remote URL]`: `git init` if absent, adopt existing repo
  otherwise; write/append `.gitignore`; verify git-lfs installed and (when a
  remote is given) that the remote answers the LFS batch API — hard refusal
  otherwise; write `.gitattributes` LFS patterns; seed `[sync]` author from
  `git config --global` (prompt if absent); run the CAS migration (§7); make
  the initial commit.
- `.gitignore` (curated, exact):
  `.clepsydra/cache.db*`, `.clepsydra/feeds.db*`, `.clepsydra/*.lock`,
  `.clepsydra/.feeds.db.*.lock`, `.clepsydra/transactions/`,
  `.clepsydra/cas/cas.db*`, `.clepsydra/cas/cas.lock`,
  `.clepsydra/crypto/*.identity.age`, `.DS_Store`.
- Synced: pages, `_attachments/`, `.clepsydra/{config.toml, templates/,
  rubbish/, crypto/keyring.toml, bcl, location.toml, importers/, cas/<blobs>}`.
  Wrapped identities travel out-of-band per device; keyring/crypto file
  permissions re-tightened (0700/0600) after checkout.
- Single remote `origin`, single branch `main` (configurable), never force-push,
  never merge unrelated histories.

## 3. LFS (v1-mandatory)

- `.gitattributes` tracks `.clepsydra/cas/**` and `_attachments/**` via LFS.
- The remote must speak LFS; documented loudly. `clep doctor` checks git-lfs
  presence and the attributes.

## 4. Cadence & config

`[sync]` section in `.clepsydra/config.toml` (which itself syncs):

```toml
[sync]
autocommit_debounce_secs = 300   # commit after quiet period; keeps worktree clean
interval_secs = 0                # 0 = no scheduled full sync
branch = "main"
author_name = "..."
author_email = "..."
```

- Debounced autocommit after mutations (worktree always committed → pull never
  meets dirty state).
- Full sync = commit + fetch + merge + push: on demand (`clep sync`, UI), on
  the optional interval, pull on `serve` start, push on shutdown.
- Commit messages machine-generated (`sync: 3 pages (Title A, Title B, …)`);
  author from config; `Device: <hostname>` trailer.

## 5. Merge & conflicts (ADR 0004)

- Fetch + merge; no rebase.
- Custom merge driver (`clep merge-driver` via `.gitattributes` for `*.md`):
  structural frontmatter merge — max `updated_at`, union `tags`, field-wise
  where both sides parse; body via standard 3-way text merge.
- Residual conflict → resolve to ours; write theirs as a Conflict Copy:
  `<stem>.conflict.<shortid>.md`, fresh page id, `conflict_of = "<original
  vault path>"`, kind/tags copied. The tree is never left conflicted.
- Encrypted (age) bodies always take the Conflict Copy path.
- Rubbish races: restore wins over purge (page present in tree is
  authoritative); orphaned `.purge-*` tombstones are swept.
- Sync engine: git via subprocess (system `git`), inside the server when
  `serve` runs; `clep sync` CLI calls the server over HTTP, or runs the same
  logic standalone when no server is up.

## 6. Quiesce & indexer safety

- All git operations run inside a quiesce window: watcher paused, mutation
  gate held write. Afterward: one full index build + link resolve, then SSE
  `index_changed`.
- Indexer conflict-guard (independent of sync; protects hand-run git): a file
  containing all three marker lines (`<<<<<<< `, `=======`, `>>>>>>> `) is
  conflicted — index read-only with existing/default metadata, never repair or
  rewrite it, emit a surfaced diagnostic. The unparseable-frontmatter case
  gets a surfaced diagnostic instead of a tracing-only warning.

## 7. CAS (ADR 0005)

- Default `archive.cas_path` becomes `<vault>/.clepsydra/cas`; explicit config
  wins.
- Capture writes `blobs = [{hash, type}]` in `[archive]` frontmatter (was
  `Vec<String>`); readers accept both shapes. One-time backfill fills types
  for existing archive pages from the current `cas.db`.
- `cas.db` is derived: gitignored, rebuilt per device — hash/size from blob
  files, types from frontmatter (snapshot blobs are `text/html`), ref_count
  recounted from live pages + rubbish items, `created_at` reset to now (delays
  GC, safe direction). `clep doctor` gains a CAS verify (recount refs, orphan
  and missing blobs); full rebuild routine callable from doctor/CLI.
- Migration (in `clep sync init`; standalone `clep cas migrate`): copy only
  blobs referenced by this vault (the recount scan) from the old store into
  the vault store; leave orphans behind.

## 8. Journals

- Post-sync automatic merger: for each `journal_date` with >1 page, interleave
  `## HH:MM` sections by time, dedupe identical sections, non-time content
  appended in source order; the older page keeps id/filename; the younger page
  is properly deleted (links rewritten). Doctor rule detects duplicates
  independently (hand-git case).
  (Amended by the 4b plan, D20: entries are `- HH:MM — ` bullets, not
  `## HH:MM` headings — journal pages have never used heading sections for
  time entries. The interleave and dedupe rules above apply to those bullets.)

## 9. Surfacing (v1)

- Doctor rules: conflict copies present (`conflict_of`), conflicted files
  (marker guard), duplicate journal dates, CAS verify.
- UI: conflicts list (reference-issues panel pattern) fed by the same data;
  resolution is ordinary editing + deleting the copy. Side-by-side merge UI
  deferred.

## 10. CLI surface

- `clep sync init [--remote URL]` — setup (§2).
- `clep sync` — one-shot full sync.
- `clep sync status` — ahead/behind, last sync, pending autocommit, conflict
  copies count.
- `clep cas migrate` — standalone CAS migration.

## Phasing (one plan per phase, merged to develop in order)

1. **sync-prereqs**: conflict-guard + diagnostics; `blobs = [{hash,type}]` +
   backfill; CAS rebuild routine; doctor checks. (Standalone value: the
   add/add repair hazard exists today.)
2. **petname-codes**: scheme, wordlists, prefix addressing, migration (§1).
3. **cas-in-vault**: default flip + `clep cas migrate` (§7).
4. **sync-core**: init, quiesce, engine, merge driver, Conflict Copies,
   journal merger, doctor/UI surfacing, CLI/API (§§2–6, 8–10).

## Out of scope (v1)

Side-by-side merge UI; feed-state (`feeds.db`) sync; size-based LFS rules;
encrypted-note structural merge; multi-remote; rebase workflows; NFC filename
sweep (tracked separately — new filenames are ASCII-only).
