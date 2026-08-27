# CAS inside the vault, blob metadata in frontmatter

The content-addressed store defaulted to `~/.clepsydra/cas`, outside the vault, so a
git-synced vault would carry archive pages whose `cas:sha256:…` references point at blobs
the other device does not have. `cas.db` also held the only copy of each resource blob's
`content_type`, which drives the HTTP Content-Type header and active-content security
gating — so the store could not be treated as derived. We decided: the CAS default moves
inside the vault (`.clepsydra/cas/`); blobs are tracked through git LFS (v1-mandatory —
the remote must speak LFS); each archive page's `[archive]` frontmatter records
`blobs = [{hash, type}]` at capture time (existing pages backfilled once from the current
`cas.db`), making `cas.db` fully derivable — it is gitignored and rebuilt per device by a
new rebuild routine, verified by `clep doctor`.

## Consequences

- Frontmatter joins the "filesystem is the source of truth" principle for blob metadata;
  ref-counts reconstruct exactly from live pages plus rubbish items.
- Migration copies only blobs referenced by this vault's pages from the global store;
  orphans stay behind. `clep sync init` performs it; `clep cas migrate` is the standalone form.
- Blob `created_at` is device-local after a rebuild; GC of dead blobs is delayed, never premature.
