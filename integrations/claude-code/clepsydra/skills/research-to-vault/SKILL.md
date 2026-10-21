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
     `bibtex`). Each result is `{cite_key, status, page_path}`; an existing
     work comes back `skipped`, with the existing page's `page_path`.
   - Any other URL: `vault_archive_url`. It returns
     `{page_id, vault_path, status}` for a page tagged `server-fetch`
     (lower fidelity than the browser extension).

   Neither result carries a title. `vault_get_page` the returned
   `page_path` / `vault_path` and keep its title for each source. A result
   without a path: `vault_search` the DOI, ISBN, or cite key for the page.
3. **Find the note.** `vault_search` for the topic. A NOTE on it exists:
   extend it with `vault_append_page`. Otherwise `vault_create_page` with
   kind `NOTE`, tags including `ai-generated` (reuse existing tags,
   `vault_tags`), the real project slug, and a wikilink to the project hub in
   the body.
4. **Write the claims.** Each claim cites its archived page as `[[Title]]`.
   A claim without an archived source says so or is left out.
5. **Report** the NOTE title, and each source with its archived page title.

## Archive failures

`vault_archive_url` can fail for one source and work for the next:

- "archiving is disabled": every URL fails the same way. DOI and ISBN
  imports still work.
- Any other error (not an HTML page, could not fetch, nested too deeply,
  no readable content, extraction busy): that one source failed.

Either way, cite the failed source by its plain URL in the NOTE, and list
each failed source with its error in the report as uncaptured.
