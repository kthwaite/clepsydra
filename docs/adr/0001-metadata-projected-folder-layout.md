# Folder layout is a projection of page metadata

## Context

Kind began as a frontend-only concept (`ui/src/lib/kind.ts`): a closed enum
resolved per page by precedence (frontmatter `type:` → top-level folder → NOTE)
and used only for coloured pips. We are promoting it to a first-class field and
generalising it: the vault's folder tree becomes a *projection* of structured
page metadata, letting the operator reorganise files through the app rather than
the filesystem.

## Decision

A page's path is derived as `<kind>/[<project>/]<filename>`:

- **`kind`** — a closed, code-defined enum, authoritative when declared in
  frontmatter `type:`; otherwise *inferred* from the top-level folder, else NOTE.
  It is the top-level folder axis and selects the frontend renderer.
- **`project`** — an optional, free-form, user-created label forming a single
  subfolder level beneath the kind.

Assigning kind/project through the UI writes the frontmatter field **and** moves
the file to the projected folder, reusing the existing `MutationOp::MovePage`
planner (which rewrites affected inbound links).

**Drift** — a declared `type:`/`project:` that disagrees with the file's current
folder — is *tolerated, not prevented*. Kind resolution stays correct (declared
wins). Drift is healed by an idempotent **reconcile** operation, keyed only on
*declared* metadata (inference never moves a file), fired from three triggers:

1. UI assignment (backend moves immediately),
2. LSP `didSave` (catches Neovim edits when the LSP is running),
3. a `serve`-startup sweep (catch-all when the LSP was not running).

## Consequences

- **The core index build stays filesystem-read-only.** Reconcile is a separate
  pass owned by the `serve` runtime, never invoked by the pure build/resolve
  path — so `doctor`, diagnostics, and CI/dry rebuilds never mutate the vault.
- Because reconcile is idempotent and declared-metadata-keyed, the three triggers
  never conflict: whoever heals first wins; the rest no-op on a consistent file.
- A reconcile window exists between an LSP-less hand-edit and the next sweep;
  during it the file is correct but mis-filed. Accepted.
- Inference accepting folder synonyms is many-to-one, but the move target must be
  one canonical folder per kind — a separate mapping from the inference map.
