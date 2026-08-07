# Bases User Documentation Design

**Date:** 2026-08-07
**Status:** Approved

## Goal

Add a canonical, user-facing guide for vault users who author and use Bases. The guide must describe the shipped feature rather than treating the implementation design as documentation.

## Deliverables

- Add `docs/bases.md` as the canonical practical guide.
- Link the guide from `docs/getting-started.md` where frontmatter and LSP workflows are introduced.
- Link the guide from `docs/lsp.md` where base-aware property assistance is described.

## Audience and structure

The primary audience is a vault user who edits Markdown pages and `.base.toml` files directly, then views and edits matching pages in Clepsydra.

The guide will cover:

1. Bases as non-owning views over pages.
2. File location, filename-to-slug mapping, and a minimal working example.
3. The relationship between TOML page properties and a base property schema.
4. Supported property types, system fields, and field disambiguation.
5. Membership filters, saved-view filters, supported operators, and nested boolean filters.
6. Columns, sorting, grouping, and aggregates.
7. Opening and editing a base in the web UI.
8. Base-aware Neovim/LSP completion and diagnostics.
9. Validation, troubleshooting, and current v1 limits.

## Content constraints

- Every schema token and behavior must be verified against the shipped Rust models and routes.
- Examples must be internally consistent: the sample page must match the sample base and saved views.
- The guide should lead with a copyable minimal example, then introduce the full reference incrementally.
- HTTP internals remain out of scope except for a short pointer to Swagger/OpenAPI; the primary audience does not need endpoint payload documentation.
- Internal phasing, migration history, implementation architecture, and speculative follow-ups do not belong in the user guide.

## Verification

- Check all documented property types, operators, system fields, aggregate functions, route paths, and UI/LSP behavior against source and focused tests.
- Run Markdown/link-oriented repository checks if present.
- Run the repository's required typecheck, lint, and test gates before completion.
