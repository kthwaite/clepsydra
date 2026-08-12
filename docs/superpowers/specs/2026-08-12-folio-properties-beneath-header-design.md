# Folio Properties Beneath Header Design

## Problem

Base-defined properties now sit in the Folio editing flow, but each value repeats its Base declaration and type on a separate provenance line. That consumes excessive vertical space and obscures the relationship between properties belonging to the same Base.

## Decision

Render Base properties in a dedicated, full-width section immediately beneath the Folio header, grouped by declaring Base. Show each Base name once as a group heading, place the property type directly after its name, and remove the visible per-property provenance line. Keep the backend-authoritative projection, typed editors, revision guards, and recovery behavior. Change grouping and presentation, not property semantics.

## Scope

- Editable Folios, read-only Folios, archived Folios, mobile Folios, and locked encrypted Folios use the same placement rule.
- The section appears after the title, tags, and aliases header and before conversation or recipe controls, Raw Markdown controls, and body content.
- A locked encrypted Folio shows the section after its visible title and tags and before the unlock panel.
- The desktop metadata rail and mobile document-details dialog no longer render Base properties.
- Grouping is derived client-side from the existing declaration data; no Base API or persistence contract changes.

## Visibility

`FolioProperties` remains mounted for a Folio with a page ID so it can load the authoritative projection.

- While loading, show a compact loading state beneath the header.
- When loading fails, show the existing diagnostic and retry action beneath the header.
- Once the projection confirms that the Folio matches no Base, render no section.
- When one or more Bases match but declare no properties, show the existing “No declared properties” explanation in the section.
- When declared properties exist, show the expanded property rows.

Hiding only the authoritative no-match state keeps ordinary notes clean without making failures look like successful emptiness.

## Presentation and Interaction

Use one `FolioProperties` implementation across every layout.

- Heading: one compact uppercase `Properties` section heading, consistent with the Folio visual language.
- Groups: show the Base display name once—without its slug—as a subheading for each matching Base that contributes at least one uniquely declared property. Use the matching-Base order from the authoritative projection.
- Shared declarations: a property declared by multiple matching Bases appears once in a final `Shared` group. Never duplicate its editor or value under each Base.
- Rows: show property name, then its type in muted monospace, then the typed value. Desktop uses a compact name/type-and-value grid. Mobile keeps name and type on one line and stacks only the value beneath it.
- Type labels: compatible properties show the normalized definition type. Conflicting properties show the distinct declaration types joined in declaration order, such as `number / text`.
- Editing: compatible, patchable properties continue to use `EditableCell` and remain directly editable.
- Provenance: remove visible declaration text beneath values. Preserve complete declaration context in visually hidden descriptive text connected through the existing `aria-describedby` relationship.
- Ordering: properties retain authoritative projection order within each group. The `Shared` group follows all Base groups. Bases without unique properties do not produce empty group headings.
- State: saving, read-only reasons, schema conflicts, reserved-property blockers, load failures, revision conflicts, retry, reload, and draft-discard actions retain their current behavior.
- Accessibility: retain the labelled section, semantically labelled Base groups, property-specific labels and descriptions, alert/status roles, focus return after save/cancel, and keyboard behavior from `EditableCell`.

The component must not gain a sidebar or document variant. A single responsive row layout prevents presentation paths from diverging.

### Base `body` column

`body` is a projection-only Base system column, not a valid declared custom property. Selecting `body` in a Base view does not add it to `PageBasePropertiesResponse.properties` and must not create a second body editor. A malformed Base that attempts to declare a custom property named `body` may still surface the existing reserved-property diagnostic; that diagnostic never exposes or edits body content.

When a matching Base view includes `body`, the rich note body remains the full-width editor immediately after the dedicated Properties section and intervening note controls. The Folio does not interleave the body with custom properties or reorder fields to match a particular Base view. This is deterministic when several Bases or views match and preserves the body’s rich-text editing surface.

## Component Changes

### `Folio`

Compose `FolioProperties` into the document flow directly after `PageEditorHeader` or `ReadOnlyPageHeader`. Remove it from `details`, which removes it from the desktop rail and mobile details dialog automatically.

Continue passing page ID, current path, locked state, and Folio read-only state from the authoritative editor instance.

### `LockedFolio`

Keep accepting the projected properties node, but render it after title/tags and before the unlock section.

### `FolioProperties`

Retain data loading and mutations. Derive compact display groups from `matching_bases` and each property’s `declarations`:

- return `null` for a successful no-match projection;
- retain explicit loading and failure states;
- assign single-declaration properties to that Base’s group;
- assign multi-declaration properties once to the final `Shared` group;
- render name and type together, with the value adjacent on desktop and immediately below on mobile;
- keep full declaration provenance visually hidden for assistive technology;
- preserve all recovery controls and mutation behavior.

## Data Flow and Errors

1. `Folio` identifies the current page and supplies its authoritative ID/path.
2. `FolioProperties` loads the Base projection with `usePageBaseProperties`.
3. A compatible edit commits through `usePropertyCommit` with the projection revision.
4. Successful commits refetch the projection and restore focus to the edited value.
5. Failed commits preserve the draft and existing retry/reload/discard recovery actions.

Property failures remain isolated: the Folio header and body continue to render and remain usable.

## Verification

### Contract tests

- Desktop DOM order is header, Properties section, then body; Properties has no `aside` ancestor.
- Mobile renders Properties in the document flow and not in the document-details dialog.
- Read-only and locked variants place Properties beneath their visible headers and expose non-editable values.
- A successful projection with no matching Base renders no Properties section.
- Loading and load failure remain visible and retryable.
- Existing typed editing, saving, conflict recovery, draft retention, focus, and accessibility tests continue to pass.
- A Base view containing `body` still renders exactly one full-width note body editor after Properties. A malformed custom `body` declaration may render only its reserved-property diagnostic, never a second body value or editor.
- Single-declaration properties render under their Base heading without a repeated visible provenance line.
- Multi-declaration properties render exactly once under `Shared`, with complete declaration context still available through `aria-describedby`.
- Compatible and conflicting properties display the correct type label immediately after the property name.
- Base groups follow authoritative matching-Base order, properties retain projection order within groups, and `Shared` is last.

### Behavioral smoke test

Run the UI and open an editable Folio that matches a Base. At desktop and mobile widths, verify that properties appear beneath the header, edit a value, observe the saved value after refetch, and confirm the metadata/details surfaces no longer contain duplicate properties.
