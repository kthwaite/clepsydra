# Lock Journal Kind Design

## Goal

Prevent an existing resolved `JOURNAL` page from being reclassified through any supported assignment surface, while retaining project assignment and making the invariant visible in Folio.

## Current behavior

- Kind is resolved from the page path and optional `type` frontmatter.
- `POST /api/vault/pages-assign/{path}` and `POST /api/vault/pages-assign-bulk` can replace `type` and reconcile the page into another canonical folder.
- Folio renders every resolved kind through the interactive `KindSelect` control.
- The effective `journal` tag is computed and cannot be removed through ordinary tag editing, but changing kind removes the classification that produces it.

## Required behavior

### Assignment invariant

1. Resolve the existing page kind from its current path and declared kind.
2. If that resolved kind is `JOURNAL`, reject a requested kind other than `JOURNAL`.
3. `JOURNAL` to `JOURNAL` assignment remains valid.
4. Assigning another kind into `JOURNAL` remains valid.
5. Project-only assignment or project clearing on a Journal remains valid.
6. Bulk assignment is atomic: if any selected page violates the invariant, reject the entire request before preparing or publishing any page mutation.
7. A prohibited assignment returns HTTP 400 with `journal kind cannot be changed` in the error message.

The server enforces supported API and MCP mutation surfaces. Direct filesystem edits remain outside server enforcement and are reconciled by normal indexing behavior.

### Folio affordance

- A resolved `JOURNAL` kind is rendered by the existing kind control in a disabled state.
- The control shows `JOURNAL · fixed`.
- Its accessible description says `Journal kind cannot be changed.`
- The control cannot open its listbox or invoke `onAssign`.
- Every non-Journal kind retains current behavior.

## Architecture

Keep assignment policy in `src/api/pages.rs`, beside the single and bulk assignment adapters. A shared helper accepts the current path, current declared kind, and requested kind, resolves the current kind once, and returns `ApiError::bad_request` only for a prohibited transition. Both adapters call it before modifying metadata.

Extend `KindSelect` with an optional immutable explanation rather than creating a second metadata display. Folio supplies the explanation only when its resolved `kind` is `JOURNAL`; React Aria's disabled state owns keyboard and pointer suppression.

## Non-goals

- Making all kinds immutable.
- Preventing creation or import of new Journal pages.
- Preventing project assignment, title edits, tag edits, aliases, or body edits on Journals.
- Adding an administrative override or migration shim.
- Policing direct filesystem edits.
