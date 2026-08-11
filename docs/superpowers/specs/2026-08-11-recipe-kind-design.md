# Recipe Kind Design

**Status:** Approved design
**Date:** 2026-08-11

## Summary

Clepsydra will add `RECIPE` as a first-class page kind with a dedicated structured Folio presentation. Recipe pages remain ordinary Markdown files. The backend continues to own page metadata, filing, indexing, and generic Markdown persistence; a focused frontend codec maps supported recipe Markdown into structured fields for reading and editing.

The codec accepts both the convention demonstrated by `ui/example-recipe.md` and an equivalent standard-Markdown form. It always writes the demonstrated convention. Unsupported or ambiguous content falls back to the generic Markdown editor so the structured UI cannot silently discard source text.

## Goals

- Add `RECIPE` to the complete backend, API, MCP, and frontend kind vocabulary.
- File declared recipes canonically under `recipes/` and infer recipes from `recipe/` or `recipes/`.
- Present recipes as title, description, ingredients, steps, and notes.
- Provide structured editing for those core sections.
- Read the supplied convention and an equivalent standard-Markdown convention.
- Persist one deterministic, human-readable Markdown representation.
- Preserve all source content or decline structured editing when lossless parsing is impossible.

## Non-goals

- Parsing ingredient quantities, units, substitutions, or nutrition into separate fields.
- Scaling quantities or converting units.
- Adding servings, cuisine, preparation time, cooking time, source, or nutrition metadata.
- Recipe import from websites or external schemas.
- Backend recipe-specific endpoints or database columns.
- Changing generic Markdown behavior for non-recipe pages.
- Automatically converting malformed or ambiguous recipe documents.

## Existing architectural fit

The backend kind vocabulary is the closed `Kind` enum in `src/vault/kind.rs`. It defines wire tokens, canonical folders, folder inference, and resolved-kind behavior. Page frontmatter uses `type` for the declared kind. The resolved kind is indexed and exposed through page APIs. OpenAPI generation carries the authoritative kind union into `ui/src/api/schema.d.ts`.

The MCP server separately enumerates valid kind tokens in tool schemas and descriptions. The frontend mirrors the generated kind through the exhaustive `KINDS` runtime list, presentation metadata, and folder inference in `ui/src/lib/kind.ts`.

`ui/src/lib/kindPresentation.tsx` is the existing boundary for kind-specific Folio behavior. Journal and AI conversation pages already use specialized presentations while other kinds use the generic editor. Recipe will use this boundary rather than adding recipe logic to shared Markdown conversion.

## Page kind and filing

Add the following kind values:

- Rust variant: `Kind::Recipe`
- wire/frontmatter token: `RECIPE`
- canonical folder: `recipes/`
- inferred folder names: `recipe` and `recipes`
- frontend label: `RECIPE`

A declared `type = "RECIPE"` remains authoritative over path inference. Assignment and creation use the existing metadata-projected folder rules: recipes without a project live in `recipes/`; recipes with a declared project use the existing project-aware canonical path calculation.

OpenAPI must be regenerated after extending the Rust enum. The MCP valid-token list, parameter descriptions, validation errors, and tests must include `RECIPE`. The frontend kind list, metadata, folder map, filter/picker coverage, and exhaustive tests must also include it.

## Canonical page representation

Recipe title stays in normal Clepsydra page metadata. It is not duplicated in the body. A canonical stored page therefore has ordinary frontmatter followed by this recipe body convention:

```markdown
Clean, clear chicken broth with charred aromatics. Makes four bowls.

INGREDIENTS
• 1.5 kilograms whole chicken
• 2 large brown onions, halved

STEPS
1. Char the aromatics until blackened in patches.
2. Poach the chicken at a bare simmer.

NOTES
**Batch-friendly**: The broth freezes well.
```

The body sections are:

1. **Description** — all content before the ingredients marker, normalized as trimmed Markdown text.
2. **Ingredients** — an ordered collection of non-empty verbatim strings.
3. **Steps** — an ordered collection of non-empty verbatim strings; numbers are presentation and serialization syntax, not stored field values.
4. **Notes** — Markdown content after the notes marker, preserved as Markdown.

The canonical serializer emits:

- `INGREDIENTS`, `STEPS`, and `NOTES` as uppercase plain-text section markers;
- `• ` before each ingredient;
- sequential `1.`, `2.`, and so on before steps;
- one blank line between the description and each section;
- normalized line endings and one terminal newline;
- all three section markers, including when a section is empty.

Ingredient and step text is opaque. The serializer does not rewrite quantities, punctuation, temperatures, units, embedded emphasis, or wording.

## Accepted input forms

The recipe codec accepts two explicit grammars.

### Demonstrated convention

- plain uppercase markers `INGREDIENTS`, `STEPS`, and `NOTES` on otherwise empty lines;
- ingredients beginning with Unicode `•`;
- steps expressed as a Markdown ordered list;
- free Markdown notes after `NOTES`.

### Standard Markdown convention

- section headings whose normalized text is `INGREDIENTS`, `STEPS`, and `NOTES`; heading levels may vary but must be consistent within the document;
- ingredients expressed as a Markdown unordered list using `-`, `*`, or `+`;
- steps expressed as a Markdown ordered list;
- free Markdown notes beneath the notes heading.

Marker matching is case-insensitive on read. Section order is fixed: ingredients, steps, notes. Each marker must occur exactly once. The parser strips only recognized section syntax and list markers; extracted field values retain their textual content.

For a body copied from `ui/example-recipe.md`, the codec recognizes and removes an initial title line when it exactly matches the page metadata title after trimming. The matched line is omitted from the structured description and canonical output. It never infers or overwrites page metadata from arbitrary first-line body text.

## Losslessness and fallback

Structured editing is available only when the codec can account for the complete body under one accepted grammar. It must not guess across malformed boundaries or discard unrecognized blocks.

The codec returns either:

```ts
type RecipeParseResult =
  | { ok: true; value: RecipeDocument; sourceFormat: "example" | "markdown" }
  | { ok: false; reason: RecipeParseFailure };
```

`RecipeDocument` contains only `description`, `ingredients`, `steps`, and `notesMarkdown`. `RecipeParseFailure` is a closed internal reason suitable for tests and a concise UI notice; it must not contain discarded content because the original body remains authoritative.

Structured parsing fails when, for example:

- a marker is missing, duplicated, or out of order;
- input mixes the two section-marker grammars ambiguously;
- an ingredient section contains content that is not an accepted list item;
- a step section contains content that is not an accepted ordered-list item;
- unsupported material appears between recognized list items or section boundaries;
- a list item uses a shape the serializer cannot round-trip without losing structure.

On failure, Folio uses the existing generic Markdown editor and displays a restrained notice that structured recipe editing is unavailable for the current format. Saving through the generic editor preserves the body through the existing page update path. Clepsydra does not automatically normalize the body merely because the page is assigned `RECIPE`.

Empty sections are valid when their markers are present. This permits incremental authoring without weakening marker validation.

## Frontend components

### Recipe codec

Add a focused module under the existing frontend kind/presentation area. It owns:

- grammar recognition;
- extraction into `RecipeDocument`;
- canonical serialization;
- explicit parse failures;
- round-trip invariants.

It must not depend on React or mutate editor state. This keeps storage semantics independently testable and prevents recipe behavior from leaking into generic Markdown conversion.

### Recipe read presentation

A successfully parsed `RECIPE` Folio opens in a dedicated read presentation. It uses existing Folio typography, spacing, color tokens, and responsive conventions. It displays:

- the shared page title and metadata controls;
- description as introductory prose;
- ingredients as scannable checklist-style rows without persisting completion state;
- steps as prominent sequential instructions;
- notes rendered with the existing safe Markdown presentation primitives.

The read view does not treat ingredients as tasks and does not persist checked state.

### Recipe edit presentation

An explicit Read/Edit control follows the established specialized-Folio pattern. Edit mode exposes:

- the existing page title control;
- a description text area;
- ingredient rows that can be added, removed, and reordered;
- step rows that can be added, removed, and reordered;
- a Markdown notes editor;
- existing shared tags, project, and kind controls.

Each ingredient and step row contains one opaque string. Reordering changes array order only. Numbering is generated from step order. Save serializes the current structured value and submits it through the existing revision-aware page update mutation.

The initial implementation must use accessible controls and keyboard-operable add, remove, and reorder behavior. It must reuse the project's existing React Aria and shared control patterns rather than introduce native interactive controls beside established components.

### Generic fallback presentation

A recipe that does not parse uses the existing generic editor, not a partially populated structured form. The fallback notice explains the accepted section structure without blocking editing. If the user repairs the source into a supported form and saves/reopens it, the specialized presentation becomes available.

## State and save flow

1. The normal page query returns page metadata, resolved kind, revision, and Markdown body.
2. Folio resolves `RECIPE` and asks the recipe presentation to parse the body with the current page title.
3. A successful parse initializes structured local state; a failure selects generic fallback.
4. Structured edits remain local until the existing save trigger runs.
5. Save serializes the complete `RecipeDocument` and uses the existing update-page mutation with the current revision.
6. Existing revision-conflict behavior remains authoritative. A conflict must not overwrite local structured state.
7. After a successful save, the cached body and revision update through the existing page editor/query flow.

Kind assignment remains separate from body normalization. Assigning a generic page to `RECIPE` may relocate it to `recipes/`, but it does not rewrite its Markdown. The dedicated view appears only if its body parses.

## Error handling

- Unknown kind tokens remain rejected at backend and MCP boundaries using existing error shapes.
- Parse failure is a frontend presentation decision, not an API error.
- Empty recipe sections are accepted and serialized deterministically.
- Empty ingredient or step rows are removed during structured state normalization before serialization; an entirely empty section remains valid.
- Revision conflicts use the existing conflict UI and must preserve unsaved structured values.
- Network and mutation failures use existing Folio save error handling.
- No parser or renderer path may throw on arbitrary page body input.

## Testing

### Backend and MCP

Extend tests to prove:

- `RECIPE` token parsing is case-insensitive and symmetric with serialization;
- canonical folder is `recipes`;
- `recipe` and `recipes` infer `Kind::Recipe`;
- declared kind remains authoritative;
- API create/list/filter/assign responses accept and return `RECIPE`;
- assignment projects recipe pages into the expected canonical folder;
- MCP create/list/assign schemas and handlers accept `RECIPE`;
- valid-token diagnostics include `RECIPE`.

Regenerated OpenAPI must expose `RECIPE` in the `Kind` enum.

### Frontend codec

Unit tests must cover:

- the complete supplied example body;
- canonical demonstrated-convention input;
- equivalent standard-Markdown input;
- case-insensitive section recognition;
- optional duplicate title-line handling;
- empty sections;
- deterministic canonical serialization;
- parse → serialize → parse semantic equality;
- malformed, missing, duplicated, reordered, mixed, and unsupported sections;
- preservation of ingredient, step, and notes text within the supported grammar.

### Frontend presentation

Component/integration tests must cover:

- `RECIPE` metadata completeness and folder inference;
- dedicated presentation selection for parseable recipes;
- generic fallback for unparseable recipes;
- add, remove, and reorder behavior for ingredients and steps;
- title, description, and notes editing;
- exact serialized save payload;
- revision-conflict preservation;
- accessible names and keyboard operation for structured controls.

### End-to-end verification

After implementation:

1. run Rust formatting checks, type/compile checks, lint, and the full Rust test suite;
2. regenerate OpenAPI and run UI typecheck, lint, and the full UI test suite;
3. launch the application and create a `RECIPE` page;
4. confirm canonical filing under `recipes/`;
5. enter description, ingredients, steps, and notes in the structured editor;
6. save, close, and reopen the page;
7. confirm the dedicated read presentation and preserved content;
8. open a standard-Markdown recipe and confirm normalization occurs only after an explicit structured save;
9. open a malformed recipe and confirm the generic editor preserves its source.

## Documentation impact

Update user-facing documentation where the supported kind vocabulary or canonical folders are enumerated. Document the accepted recipe body forms, canonical output, and non-destructive generic fallback. Do not add a separate storage or API concept for recipes; they remain ordinary Markdown pages with `type = "RECIPE"`.

## Acceptance criteria

The feature is complete when:

- every authoritative and mirrored kind vocabulary recognizes `RECIPE`;
- create, list, filter, assign, canonical filing, and folder inference work end to end;
- parseable recipes open in a dedicated structured read/edit presentation;
- both approved input forms parse into the same core model;
- structured save emits the demonstrated convention deterministically;
- unsupported input remains editable without content loss in the generic editor;
- no quantity/unit semantics or unapproved metadata fields are introduced;
- all verification gates and browser scenarios pass.
