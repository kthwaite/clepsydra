# Clepsydra Stray Thoughts P2 Program Design

**Date:** 2026-08-11
**Status:** Approved design, pending written-spec review
**Source:** `Clepsydra: Stray Thoughts`

## Goal

Deliver the remaining P2 improvements as four independently releasable subsystem waves. Each wave uses the existing source-of-truth and persistence contracts, passes focused review and repository verification, merges to `develop`, and becomes the base for the next wave.

The program includes nine items:

1. Include journal time headings in Folio Contents and reading-position ticks.
2. Replace Gazetteer's full tag array with an accessible tag picker.
3. Add **+ New** to the sheaf tab strip using the existing page-creation flow.
4. Replace Bases property and column management lists with reorderable tables.
5. Add suggestions and creation to RSS group fields.
6. Make RSS groups and feeds collapsible with per-vault local persistence.
7. Add one read-only page-body field to Base views.
8. Add an explicit-apply raw Markdown editing mode to Folio.
9. Add a split RSS list and stored-content reading pane.

S3-compatible remote backup is explicitly excluded from this round by user decision. Third-party iframe embedding and article extraction are also excluded.

## Delivery model

This is a staged program, not a long-lived mega-branch. Each wave receives its own detailed specification, TDD implementation plan, feature worktree, focused reviews, verification gates, browser smoke test, commits, and merge to `develop`. A later wave starts from the merged predecessor.

The approved order optimizes for early user value while keeping changes cohesive:

1. Navigation and creation.
2. RSS management and reading.
3. Bases schema presentation.
4. Raw Markdown.

## Wave 1: Navigation and creation

### Journal time navigation

`journal-time` Slate elements become level-two entries in the existing Folio table-of-contents model. They display their frozen `HH:MM` value in Contents and generate ordinary level-two reading-position ticks. Selecting either control scrolls through the existing scroll-spy path to the journal-time element.

This change does not introduce a second navigation model or convert journal-time elements back into editable headings. Ordinary headings retain their current numbering and depth behavior; time entries participate in document order at level two.

### Gazetteer tag picker

Replace the full rendered tag array with an accessible multi-select combobox backed by the existing tag-count query. The picker:

- filters known indexed tags case-insensitively;
- supports keyboard navigation, selection, and removal;
- displays selected filters as removable values;
- supports clear-all;
- exposes loading, error, and retry states;
- selects only known indexed tags rather than creating metadata;
- preserves active URL filters when the suggestion request fails.

The route search remains authoritative. Selection changes update navigation history through the existing Gazetteer search reducer, compose with text, Kind, Project, sort, and page filters, and remain bookmarkable and compatible with back/forward navigation.

### Sheaf **+ New**

Add a real action button to the sheaf tab strip. It is not represented as a synthetic tab. Activating it opens the existing page-creation dialog. Cancel creates nothing. A successful create opens and activates the new page through the existing workspace tab action. Existing validation and create errors remain inside the dialog. Repeated activation cannot open multiple dialogs or duplicate successful page opens.

## Wave 2: RSS management and reading

### Group picker

Every RSS group edit surface becomes an editable combobox. Existing manifest groups are suggested case-insensitively and deduplicated by the same normalized equality used by manifest operations. A nonmatching non-empty value creates a new group.

Group changes continue through the existing feed-manifest revision and compare-and-swap mutation path. The picker does not add a frontend-only group store or bypass manifest diagnostics and conflicts.

### Collapsible groups and feeds

RSS groups and individual feed rows become accessible disclosures. Collapsed state is a per-vault local workspace preference keyed by stable group identity and feed ID. It survives route changes and browser reloads for the same vault, but never enters `feeds.md` and never causes a manifest revision conflict.

State for removed feed IDs and obsolete groups is pruned opportunistically when current subscriptions are reconciled. A missing preference store degrades to all sections expanded.

### Split reader

At desktop widths, `/feeds` becomes two independently scrolling columns: the existing filtered/paginated river and a reading pane. Selecting an entry places its ID in route search state so selection is bookmarkable and compatible with browser history. Selection must not reset filters, loaded pages, or list scroll.

The reading pane renders only content already sanitized and stored by the feed subsystem. It does not load a third-party iframe, refetch the source article, or perform reader extraction. **Open original** remains an explicit external action.

If stored content is absent, the pane shows available metadata, a stored excerpt when present, and **Open original**. If a selected entry has been pruned or is unavailable, the selection is cleared without changing river filters. On mobile, the same contract uses a single-column list-to-detail transition with an explicit return action.

## Wave 3: Bases schema presentation

### Reorderable property and column tables

Replace the current property-declaration and view-column management lists with compact tables. Rows expose stable names/keys, relevant configuration summaries, existing edit/remove actions, and accessible drag handles.

Pointer drag and keyboard movement reorder the existing unsaved complete-definition draft. Position changes are announced to assistive technology. Reordering never writes immediately; explicit **Save** remains the sole persistence boundary and continues to use the revisioned complete-definition update. Discard restores the loaded order.

Removing or reordering a declaration does not mutate any page frontmatter. Property keys and column keys remain stable; the change alters ordering only. Mobile and narrow layouts retain the same actions without relying on horizontal drag gestures.

### Unique read-only body field

Add a system body field that a Base table view may include at most once. It is a view column, not a user property declaration, and it does not write a frontmatter key. Shared backend definition validation rejects duplicate body columns or attempts to declare body as an ordinary property; the UI prevents these states but is not the sole enforcement layer.

The column displays a bounded plain-text excerpt and opens the corresponding Folio for editing. Inline table editing is excluded. Encrypted or locked bodies expose no excerpt.

Body projection must be supplied in the bounded Base evaluation response. Rendering a visible result page may not issue one body request per row. The backend applies the same authorization/protection semantics used by page detail and returns only the excerpt required by the table. The field remains unique in each view; other views in the same Base may independently include it once.

## Wave 4: Raw Markdown Folio mode

Editable Folios gain a rich/raw mode switch. Locked and declaratively read-only Folios do not expose it.

Entering raw mode snapshots the current unsaved Markdown representation and opens that exact text in a plain Markdown editor. Raw edits remain local until one of two explicit actions:

- **Apply** performs one Markdown-to-Slate conversion and replaces the current rich draft only on success.
- **Cancel** restores the snapshot and returns to rich mode without mutation.

A conversion failure keeps the user in raw mode, displays actionable diagnostics, and retains the exact raw text. No parse-on-every-keystroke synchronization is introduced.

After Apply, the existing Folio autosave, page revision, mutation, and conflict machinery remains the only persistence path. Apply does not invent a second save endpoint or revision. A remote revision conflict uses the existing conflict UI and never silently reapplies raw content over a newer page.

Route-away follows existing unsaved-change protection. Switching modes without changing content must not normalize or save Markdown. Rich-to-raw-to-rich round trips preserve all structures supported by the existing converters, and unsupported or invalid input remains recoverable in raw mode.

## Shared interaction and state invariants

- Existing canonical files remain authoritative: Markdown pages, `feeds.md`, and `bases/*.base.toml`.
- URL search remains authoritative for Gazetteer filters and selected RSS entry.
- Per-vault local preferences hold only RSS disclosure state, never domain data.
- Existing revision/CAS paths remain the sole persistence boundary for page, feed-manifest, and Base-definition changes.
- Loading or retry state never clears a valid current selection or filter.
- No N+1 body fetches are introduced for Base results.
- Sanitized stored feed content is the only HTML rendered in the reader.
- Every new control is keyboard operable, has an accessible name and state, and remains usable at mobile breakpoints.

## Error handling

- Tag-index failure leaves Gazetteer usable with its current URL filters and offers retry.
- Page-creation errors remain in the existing dialog and create no tab.
- RSS manifest conflicts retain the user's chosen group and use existing conflict feedback.
- Missing RSS selections clear only the selected entry, not river query state.
- Unavailable stored feed content uses the metadata/excerpt fallback.
- Stale Base-definition saves retain the unsaved reordered draft and use existing reload/discard conflict handling.
- Protected Base rows never expose body excerpts.
- Raw Markdown conversion errors retain exact input; save conflicts use existing Folio conflict resolution.

## Verification contract

Every wave begins with failing tests for observable behavior and ends with focused review plus the applicable repository gates.

### Wave 1 proof

Tests and browser smoke must demonstrate:

- journal-time elements appear in Contents and reading ticks in document order;
- both navigation controls scroll to the correct element;
- Gazetteer tag selection composes with text, Kind, Project, sort, and pagination;
- loading/error/retry do not broaden or clear filters;
- URL history restores picker state;
- **+ New** opens one creation dialog, cancel is inert, and success opens the created page tab.

### Wave 2 proof

Tests and browser smoke must demonstrate:

- existing group suggestions, exact deduplication, and new-group creation;
- manifest conflict behavior retains the draft;
- group/feed collapse works by pointer and keyboard and survives reload in the same vault;
- obsolete disclosure state is pruned;
- entry selection is URL-addressable and does not reset pagination or list scroll;
- sanitized stored content renders at desktop and mobile widths;
- missing content and missing entry fallbacks behave as specified;
- no iframe or source-article fetch occurs.

### Wave 3 proof

Tests and browser smoke must demonstrate:

- pointer and keyboard reorder of property and column rows;
- save/reload preserves exact order and discard restores the loaded order;
- page frontmatter is unchanged by schema reordering;
- body may appear once per view and invalid duplicate definitions are rejected by the backend;
- evaluation returns bounded excerpts without per-row requests;
- encrypted/locked rows expose no body;
- selecting a body cell opens the Folio.

### Wave 4 proof

Tests and browser smoke must demonstrate:

- entering raw mode uses the current unsaved draft;
- Cancel makes no mutation;
- Apply converts once and round-trips through rich mode, save, and reload;
- invalid raw input remains exact and visible with diagnostics;
- unchanged mode switching does not save or normalize;
- route-away and remote revision conflicts preserve recoverability;
- locked and read-only Folios expose no raw-edit action.

### Repository gates

For every wave:

- affected focused tests;
- UI typecheck;
- UI lint;
- full UI test suite;
- production UI build;
- desktop and mobile browser smoke tests against a disposable vault.

When backend contracts change, also run:

- Rust formatting check;
- Clippy across all targets and features with warnings denied;
- full Cargo test suite;
- OpenAPI regeneration and generated-client type verification.

## Integration and completion

Each wave receives focused code review before merge. Review corrections must be covered by behavioral tests. A wave merges to `develop` only after all applicable gates and smoke scenarios pass. Its worktree and merged branch are then removed.

The corresponding `Clepsydra: Stray Thoughts` checkbox is marked complete through the vault MCP only after the merged wave is verified. No compatibility aliases, duplicate controls, abandoned draft fields, or parallel persistence paths remain after a clean cutover.
