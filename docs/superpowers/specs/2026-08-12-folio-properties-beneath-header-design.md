# Folio Properties Beneath Header Design

## Problem

Base-defined properties for a Folio currently appear in the desktop metadata rail and the mobile document-details dialog. That separates editable note metadata from the note-editing flow and makes routine property editing dependent on secondary navigation.

## Decision

Render Base properties in a dedicated, full-width section immediately beneath the Folio header. Keep the existing backend-authoritative projection, typed editors, revision guards, and recovery behavior. Change placement and presentation, not property semantics.

## Scope

- Editable Folios, read-only Folios, archived Folios, mobile Folios, and locked encrypted Folios use the same placement rule.
- The section appears after the title, tags, and aliases header and before conversation or recipe controls, Raw Markdown controls, and body content.
- A locked encrypted Folio shows the section after its visible title and tags and before the unlock panel.
- The desktop metadata rail and mobile document-details dialog no longer render Base properties.
- No Base API or persistence contract changes.

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

- Heading: compact uppercase `Properties`, consistent with the Folio visual language.
- Rows: property name and typed value form the primary compact row.
- Editing: compatible, patchable properties continue to use `EditableCell` and remain directly editable.
- Provenance: Base declaration names and schema details remain secondary text beneath the corresponding row.
- State: saving, read-only reasons, schema conflicts, reserved-property blockers, load failures, revision conflicts, retry, reload, and draft-discard actions retain their current behavior.
- Accessibility: retain the labelled section, property-specific labels and descriptions, alert/status roles, focus return after save/cancel, and keyboard behavior from `EditableCell`.

The component must not gain a sidebar or document variant. A single responsive row layout prevents presentation paths from diverging.

## Component Changes

### `Folio`

Compose `FolioProperties` into the document flow directly after `PageEditorHeader` or `ReadOnlyPageHeader`. Remove it from `details`, which removes it from the desktop rail and mobile details dialog automatically.

Continue passing page ID, current path, locked state, and Folio read-only state from the authoritative editor instance.

### `LockedFolio`

Keep accepting the projected properties node, but render it after title/tags and before the unlock section.

### `FolioProperties`

Retain data loading and mutations. Update visibility handling and styling for a centered document column rather than a narrow rail:

- return `null` for a successful no-match projection;
- retain explicit loading and failure states;
- use compact responsive rows instead of vertically dominant sidebar cards;
- preserve secondary provenance and all recovery controls.

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

### Behavioral smoke test

Run the UI and open an editable Folio that matches a Base. At desktop and mobile widths, verify that properties appear beneath the header, edit a value, observe the saved value after refetch, and confirm the metadata/details surfaces no longer contain duplicate properties.
