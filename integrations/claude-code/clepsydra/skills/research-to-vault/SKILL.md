---
name: research-to-vault
description: Use only on an explicit request such as "research X into the vault" or "archive these sources" — archives primary sources into the clepsydra vault and writes one cited NOTE.
---

# Researching into the vault

Archive each primary source, then write one NOTE whose claims cite the
archived pages. Vocabulary and tool rules come from the vault skill.

## Steps

1. **Gather primary sources** for the topic (papers, books, official docs,
   standards). Prefer the original publisher over commentary.
2. **Archive each source.**
   - DOI or ISBN: `vault_import_work` (exactly one of `doi`, `isbn`,
     `bibtex`). It dedupes; an existing work comes back as is.
   - Any other URL: `vault_archive_url`. It returns the archived page,
     tagged `server-fetch` (lower fidelity than the browser extension).
   Keep the returned page title for each source.
3. **Find the note.** `vault_search` for the topic. A NOTE on it exists:
   extend it with `vault_append_page`. Otherwise `vault_create_page` with
   kind `NOTE`, tags including `ai-generated` (reuse existing tags,
   `vault_tags`), the real project slug, and a wikilink to the project hub in
   the body.
4. **Write the claims.** Each claim cites its archived page as `[[Title]]`.
   A claim without an archived source says so or is left out.
5. **Report** the NOTE title, and each source with its archived page title.

## Archiving disabled

`vault_archive_url` fails with "archiving is disabled". Cite plain URLs for
those sources, and tell the user archiving is off and the sources are
uncaptured. DOI and ISBN imports still work.
