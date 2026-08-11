# Recipe Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `RECIPE` as a complete Clepsydra page kind with canonical filing, dual-format recipe parsing, deterministic example-format persistence, and a lossless structured Folio read/edit experience.

**Architecture:** Rust remains authoritative for the kind vocabulary and generic page persistence. A pure frontend codec maps supported Markdown into a small `RecipeDocument`; a recipe-specific Folio component edits that model and writes canonical Markdown through a raw-body extension to the existing revision-aware page editor. Unparseable recipe bodies stay on the generic Markdown surface without normalization or data loss.

**Tech Stack:** Rust, Axum/utoipa, rmcp/schemars, React 19, TypeScript, React Aria Components, Slate, Vitest/Testing Library, MDX, Bun, Cargo.

## Global Constraints

- Before implementation, create an isolated worktree with `superpowers:using-git-worktrees`; execute from that worktree.
- Use TDD for every behavioral task: observe the focused test fail before production changes, then pass before commit.
- `RECIPE` is the exact wire/frontmatter token; `recipes/` is its canonical folder; `recipe` and `recipes` are inference aliases.
- Recipe title remains normal page metadata and is never duplicated by canonical body serialization.
- The codec accepts the supplied uppercase/Unicode-bullet grammar and the approved standard-Markdown grammar; it always serializes the supplied grammar.
- Ingredients and steps are opaque strings. Do not infer quantities, units, timings, servings, cuisine, source, or nutrition.
- Structured editing is all-or-nothing: unsupported or ambiguous source uses the generic editor and remains byte-authoritative until the user explicitly repairs it.
- Assigning `RECIPE` moves/files the page but never normalizes its body.
- Reuse React Aria/shared controls and Vessel design tokens; do not add raw interactive controls beside an existing project primitive.
- Do not add runtime dependencies.
- Generated `ui/src/api/schema.d.ts` must be regenerated from the backend OpenAPI endpoint, never hand-edited.
- Each task receives a two-stage review before the next task: first spec compliance, then code quality.
- Final verification must include Rust typecheck/lint/tests, UI typecheck/lint/tests, and a real browser smoke test.

---

## File structure

### Backend and contracts

- Modify `src/vault/kind.rs` — authoritative enum, token/folder mappings, and unit tests.
- Modify `src/mcp/server.rs` — MCP kind token documentation/validation and create/list/assign coverage.
- Modify `tests/api_test.rs` — HTTP create/list/filter/assign behavior for `RECIPE`.
- Modify `tests/openapi_contract.rs` — assert generated OpenAPI includes `RECIPE`.
- Regenerate `ui/src/api/schema.d.ts` — generated `Kind` union.

### Frontend kind and persistence infrastructure

- Modify `ui/src/lib/kind.ts` — runtime kind list, label/color, and folder inference.
- Modify `ui/src/lib/kind.test.ts` — recipe metadata/inference tests.
- Modify `ui/src/lib/kindPresentation.tsx` — add the `recipe` body-presentation discriminator.
- Modify `ui/src/lib/kindPresentation.test.tsx` — presentation selection and exhaustiveness.
- Modify `ui/src/editor/usePageEditor.ts` — add a raw Markdown body setter that participates in existing autosave, encryption, stale-flight, and revision-conflict behavior.
- Create `ui/src/editor/__tests__/usePageEditor.raw-body.test.tsx` — focused raw-body save invariants, unless the existing hook test harness is more reusable in another `usePageEditor.*.test.tsx` file.

### Recipe domain and UI

- Create `ui/src/recipe/recipeCodec.ts` — pure parse/serialize API and closed parse failures.
- Create `ui/src/recipe/recipeCodec.test.ts` — both grammars, canonicalization, round trips, and lossless rejection.
- Create `ui/src/components/codex/recipe/RecipeFolioBody.tsx` — mode controls, structured read view, structured editor, and generic fallback notice.
- Create `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx` — component behavior and accessibility.
- Modify `ui/src/components/codex/Folio.tsx` — select recipe presentation, share header/read-only/save behavior, and hand the page-editor contract to `RecipeFolioBody`.
- Create `ui/src/components/codex/__tests__/FolioRecipe.test.tsx` — Folio integration, exact save payload, fallback, conflict, and path reset.

### User documentation

- Create `ui/src/docs/content/recipes.mdx` — accepted formats, canonical save output, filing, and fallback behavior.
- Modify `ui/src/docs/registry.ts` — register the Recipes guide under Features.
- Modify `ui/src/docs/registry.test.ts` and `ui/src/docs/mdx-smoke.test.tsx` — hierarchy and compilation/content coverage.

---

### Task 1: Authoritative `RECIPE` kind and MCP/API contracts

**Files:**
- Modify: `src/vault/kind.rs:17-108,142-249`
- Modify: `src/mcp/server.rs:100-230,151-167,458-580,785-816,1552-1670,1850-1916`
- Modify: `tests/api_test.rs` (reuse page create/list/assign helpers at their existing locations)
- Modify: `tests/openapi_contract.rs`

**Interfaces:**
- Consumes: existing `Kind`, page create/list/assign APIs, `resolve_create_folder`, and MCP request types.
- Produces: `Kind::Recipe`; `Kind::Recipe.as_str() == "RECIPE"`; `Kind::Recipe.canonical_folder() == "recipes"`; `Kind::from_token("recipe")`; `Kind::from_folder("recipe" | "recipes")`; OpenAPI `Kind` enum entry; MCP acceptance of `RECIPE`.

- [ ] **Step 1: Write all failing backend contract tests**

In `src/vault/kind.rs`, replace the explicit recipe-rejection assertion and extend exhaustive tests:

```rust
assert_eq!(Kind::from_token("recipe"), Some(Kind::Recipe));
assert_eq!(Kind::Recipe.as_str(), "RECIPE");
assert_eq!(Kind::Recipe.canonical_folder(), "recipes");
assert_eq!(Kind::from_folder("recipe"), Some(Kind::Recipe));
assert_eq!(Kind::from_folder("recipes"), Some(Kind::Recipe));
```

Add `Kind::Recipe` to the exhaustive `all` array and serde round-trip cases.

In `src/mcp/server.rs`, convert the three `recipe` rejection cases into positive create/list/assign cases:

```rust
#[tokio::test]
async fn create_page_accepts_recipe_and_uses_canonical_folder() {
    let (server, _tmp) = serve_seeded_vault().await;
    let value = parse(server.vault_create_page(Parameters(CreatePageParams {
        kind: Some("recipe".to_string()),
        body: Some("INGREDIENTS\n\nSTEPS\n\nNOTES\n".to_string()),
        ..create_params("Soup")
    })).await);
    assert_eq!(value["kind"], "RECIPE");
    assert!(value["path"].as_str().unwrap().starts_with("recipes/"));
}
```

Extend `list_pages_filters_by_tag_kind_and_project` so a seeded recipe is returned by `kind: Some("recipe")`. Rename the assignment test to `assign_accepts_recipe` and assert the page moves under `recipes/` with kind `RECIPE`. Retain unknown-kind coverage with `"banana"` and require the error to enumerate `RECIPE`.

In `tests/api_test.rs`, add `recipe_kind_create_filter_and_assign`. Using the existing temporary-vault HTTP harness, prove:

```text
POST create page with kind RECIPE
→ response.kind == RECIPE
→ response.path starts recipes/
GET list?kind=recipe
→ created page is returned
assign an ordinary NOTE to RECIPE
→ response path starts recipes/
```

In `tests/openapi_contract.rs`, inspect `components.schemas.Kind.enum` and assert it contains the exact string `RECIPE`.

- [ ] **Step 2: Run the backend contract tests and observe the compile failure**

Run:

```bash
cargo test vault::kind::tests --lib
cargo test mcp::server::tests::create_page_accepts_recipe_and_uses_canonical_folder --lib
cargo test --test api_test recipe_kind_create_filter_and_assign
cargo test --test openapi_contract
```

Expected: FAIL because `Kind::Recipe` does not exist.

- [ ] **Step 3: Implement the authoritative enum and mappings**

Add the variant and every exhaustive match arm:

```rust
pub enum Kind {
    // existing variants
    Recipe,
    #[schema(rename = "AI_CONVERSATION")]
    AiConversation,
}
```

```rust
Kind::Recipe => "recipes",       // canonical_folder
Kind::Recipe => "RECIPE",        // as_str
"RECIPE" => Some(Kind::Recipe),  // from_token
"recipes" | "recipe" => Some(Kind::Recipe), // from_folder
```

Do not add extra folder synonyms. The existing generic API/index/assignment paths must carry the new kind without recipe-specific branches.

- [ ] **Step 4: Update MCP vocabulary and descriptions**

Set:

```rust
const KIND_TOKENS: &str =
    "NOTE, PROJECT, JOURNAL, TODO, QUOTE, BOOK, CAPTURE, CODE, PERSON, TASK, CYCLE, RECIPE, AI_CONVERSATION";
```

Update the `ListPagesParams.kind`, `CreatePageParams.kind`, and `AssignParams.kind` doc comments to enumerate `RECIPE` and `AI_CONVERSATION`. Keep handler parsing delegated to `Kind::from_token`.

- [ ] **Step 5: Run backend formatting and contract tests**

Run:

```bash
cargo fmt --check
cargo test vault::kind::tests --lib
cargo test mcp::server::tests --lib
cargo test --test api_test recipe_kind_create_filter_and_assign
cargo test --test openapi_contract
```

Expected: PASS.

- [ ] **Step 6: Commit the backend contract**

```bash
git add src/vault/kind.rs src/mcp/server.rs tests/api_test.rs tests/openapi_contract.rs
git commit -m "feat(vault): add recipe page kind"
```

---

### Task 2: Generated frontend kind vocabulary and presentation selector

**Files:**
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/lib/kind.ts:20-108`
- Modify: `ui/src/lib/kind.test.ts:12-111`
- Modify: `ui/src/lib/kindPresentation.tsx:15-49`
- Modify: `ui/src/lib/kindPresentation.test.tsx`

**Interfaces:**
- Consumes: Task 1 OpenAPI `Kind` enum containing `RECIPE`.
- Produces: generated TypeScript `Kind` union containing `RECIPE`; `KINDS` entry; `KIND_META.RECIPE`; recipe folder inference; `presentationFor("RECIPE").bodyPresentation === "recipe"`.

- [ ] **Step 1: Add failing frontend kind and presentation tests**

Add exact assertions:

```ts
expect(KINDS).toContain("RECIPE");
expect(resolveKindFromPath("recipes/pho-ga.md")).toBe("RECIPE");
expect(resolveKindFromPath("recipe/pho-ga.md")).toBe("RECIPE");
expect(kindLabel("RECIPE")).toBe("RECIPE");
expect(presentationFor("RECIPE").bodyPresentation).toBe("recipe");
```

Retain the loops proving every generated `Kind` has metadata and a presentation.

- [ ] **Step 2: Run the tests and observe failure**

Run:

```bash
bun --cwd ui run test src/lib/kind.test.ts src/lib/kindPresentation.test.tsx
```

Expected: FAIL because the generated union/runtime list does not yet expose `RECIPE` and presentation returns `editor`.

- [ ] **Step 3: Regenerate OpenAPI types from the Task 1 backend**

Start the Clepsydra server against a temporary initialized vault on port 3000 using the repository's existing test/dev configuration. Keep it under the harness process manager. Then run:

```bash
bun --cwd ui run openapi
```

Stop the server after generation. Confirm `components["schemas"]["Kind"]` contains `"RECIPE"`; do not edit `schema.d.ts` by hand.

- [ ] **Step 4: Update runtime kind metadata and folder inference**

Insert `"RECIPE"` before `"AI_CONVERSATION"` in `KINDS`. Add:

```ts
RECIPE: { label: "RECIPE", color: "var(--accent-deep)" },
```

Add only:

```ts
recipes: "RECIPE",
recipe: "RECIPE",
```

The existing compile-time `MissingFromKinds` and `Record<Kind, KindMeta>` checks remain unchanged.

- [ ] **Step 5: Extend the presentation discriminator**

Change the type to:

```ts
bodyPresentation: "editor" | "ai-conversation" | "recipe";
```

and register:

```ts
RECIPE: {
  bodyPresentation: "recipe",
  metaExtras: null,
},
```

Do not import the recipe component into the registry; the registry selects behavior, while Folio owns rendering.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
bun --cwd ui run test src/lib/kind.test.ts src/lib/kindPresentation.test.tsx
bun --cwd ui run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit generated and handwritten frontend contracts**

```bash
git add ui/src/api/schema.d.ts ui/src/lib/kind.ts ui/src/lib/kind.test.ts ui/src/lib/kindPresentation.tsx ui/src/lib/kindPresentation.test.tsx
git commit -m "feat(ui): register recipe kind presentation"
```

---

### Task 3: Lossless recipe Markdown codec

**Files:**
- Create: `ui/src/recipe/recipeCodec.ts`
- Create: `ui/src/recipe/recipeCodec.test.ts`
- Read fixture: `ui/example-recipe.md` (do not make the test depend on this untracked/manual file; copy the relevant body into a test constant)

**Interfaces:**
- Consumes: plain Markdown body and page metadata title.
- Produces:

```ts
export type RecipeDocument = {
  description: string;
  ingredients: string[];
  steps: string[];
  notesMarkdown: string;
};

export type RecipeParseFailure =
  | "missing-section"
  | "duplicate-section"
  | "section-order"
  | "mixed-format"
  | "invalid-ingredient"
  | "invalid-step"
  | "unsupported-content";

export type RecipeParseResult =
  | { ok: true; value: RecipeDocument; sourceFormat: "example" | "markdown" }
  | { ok: false; reason: RecipeParseFailure };

export function parseRecipeMarkdown(
  body: string,
  pageTitle: string,
): RecipeParseResult;

export function serializeRecipeMarkdown(document: RecipeDocument): string;
```

- [ ] **Step 1: Write failing canonical parse and serialization tests**

Use a compact representative fixture:

```ts
const example = `Phở Gà
Clear broth. Makes four bowls.

INGREDIENTS
• 1 whole chicken
• 2 onions

STEPS
1. Char the onions.
2. Simmer the chicken.

NOTES
**Batch-friendly**: Freeze the broth.
`;

expect(parseRecipeMarkdown(example, "Phở Gà")).toEqual({
  ok: true,
  sourceFormat: "example",
  value: {
    description: "Clear broth. Makes four bowls.",
    ingredients: ["1 whole chicken", "2 onions"],
    steps: ["Char the onions.", "Simmer the chicken."],
    notesMarkdown: "**Batch-friendly**: Freeze the broth.",
  },
});
```

Assert the serializer omits `Phở Gà`, emits Unicode bullets and sequential step numbers, includes all markers, and ends with exactly one newline.

- [ ] **Step 2: Run codec tests and observe module-not-found failure**

Run:

```bash
bun --cwd ui run test src/recipe/recipeCodec.test.ts
```

Expected: FAIL because `recipeCodec.ts` does not exist.

- [ ] **Step 3: Implement the demonstrated grammar minimally**

Use line-oriented parsing rather than the shared Markdown AST because uppercase markers and `•` are deliberately non-GFM syntax. Normalize CRLF to LF for recognition. Require exactly one marker in fixed order. Recognize a duplicate first title line only by exact trimmed equality with `pageTitle`. Parse each ingredient with `/^•\s+(.+)$/u` and each step with `/^\d+[.)]\s+(.+)$/u` only when the captured value is non-empty.

Keep helpers private and return a failure instead of dropping any non-blank line in ingredients or steps.

- [ ] **Step 4: Run demonstrated-format tests and observe success**

Run: `bun --cwd ui run test src/recipe/recipeCodec.test.ts`

Expected: the demonstrated-format and serializer tests PASS.

- [ ] **Step 5: Add failing standard-Markdown and empty-section tests**

Cover:

```md
Intro paragraph.

## Ingredients
- chicken
- onion

## Steps
1. Simmer.
2. Serve.

## Notes
Use **fresh** herbs.
```

Require consistent heading depth, any of `-`, `*`, `+` for ingredients, ordered steps, case-insensitive marker text, and semantic equality with the demonstrated form. Add empty-section input with all three markers and no rows.

- [ ] **Step 6: Implement the standard-Markdown grammar**

Recognize heading markers with `/^(#{1,6})\s+(ingredients|steps|notes)\s*$/i`; require the same captured hash count for all three. Recognize unordered rows with `/^[-*+]\s+(.+)$/u`. Do not accept nested, continuation, task-list, or multi-paragraph list items because the canonical model cannot preserve their structure.

- [ ] **Step 7: Add failing rejection and round-trip tests**

Add table-driven cases for missing, duplicated, reordered, mixed marker styles, non-list section content, nested/continued items, content between list rows, and malformed steps. For every failure, assert only the closed reason and retain the original source variable unchanged. Add:

```ts
const parsed = parseRecipeMarkdown(input, title);
expect(parsed.ok).toBe(true);
if (parsed.ok) {
  expect(parseRecipeMarkdown(serializeRecipeMarkdown(parsed.value), title)).toEqual({
    ok: true,
    sourceFormat: "example",
    value: parsed.value,
  });
}
```

- [ ] **Step 8: Complete parser diagnostics and normalization**

Classify failures deterministically in this precedence: missing/duplicate markers, order, mixed format, invalid ingredient/step, unsupported content. Trim boundary blank lines, preserve internal Markdown/punctuation in description and notes, and remove empty ingredient/step values during serialization without changing non-empty strings.

- [ ] **Step 9: Run codec tests, typecheck, and lint the files**

Run:

```bash
bun --cwd ui run test src/recipe/recipeCodec.test.ts
bun --cwd ui run typecheck
bun --cwd ui x biome lint src/recipe/recipeCodec.ts src/recipe/recipeCodec.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit the codec**

```bash
git add ui/src/recipe/recipeCodec.ts ui/src/recipe/recipeCodec.test.ts
git commit -m "feat(ui): add lossless recipe markdown codec"
```

---

### Task 4: Raw Markdown updates through `usePageEditor`

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts:76-108,268-296,298-502,570-696`
- Create: `ui/src/editor/__tests__/usePageEditor.raw-body.test.tsx`

**Interfaces:**
- Consumes: existing `usePageEditor` save generations, revision, encryption, mutation, Slate conversion, and conflict flow.
- Produces: `PageEditorState.setBodyMarkdown(markdown: string): void`; `getPlaintext()` returns the latest structured body; `saveNow()` persists the exact supplied Markdown rather than a Slate-normalized variant.

- [ ] **Step 1: Write a failing exact-body save test**

Using the existing `usePageEditor` hook test setup/mocks, render the hook with saved body `"old\n"`, call:

```ts
act(() => {
  result.current.setBodyMarkdown("INGREDIENTS\n• stock\n\nSTEPS\n1. Simmer.\n\nNOTES\n");
});
await act(() => result.current.saveNow());
```

Assert the update mutation receives that exact body and the current `expected_revision`. Also assert `getPlaintext()` returns the exact body before the network promise resolves.

- [ ] **Step 2: Run the focused test and observe the type/API failure**

Run:

```bash
bun --cwd ui run test src/editor/__tests__/usePageEditor.raw-body.test.tsx
```

Expected: FAIL because `setBodyMarkdown` is absent.

- [ ] **Step 3: Implement a raw-body override without bypassing save invariants**

Add:

```ts
const bodyOverrideRef = useRef<string | null>(null);
```

Expose:

```ts
setBodyMarkdown: (markdown: string) => void;
```

The setter synchronously sets `bodyOverrideRef.current`, refreshes `editorValueRef.current = markdownToSlate(markdown)` for future generic fallback, increments `bodyEditGenRef`, and calls `scheduleSave()`.

In `onSlateChange`, clear `bodyOverrideRef.current` before recording a Slate edit. In `savePass`, snapshot the override and choose:

```ts
const body = bodyDirty
  ? (bodyOverrideAtSave ?? slateToMarkdown(editorValueRef.current))
  : savedRef.current.body;
```

Clear the override after success only when no newer body generation exists and the ref still equals the saved snapshot. Clear it on path reset, server-body adoption, lock transition, and conflict reload. `getPlaintext()` returns the override first when dirty.

- [ ] **Step 4: Add failing concurrency, fallback, and conflict tests**

Cover these observable contracts:

1. a second `setBodyMarkdown` during an in-flight save remains dirty and is sent by the queued save;
2. a subsequent Slate `onSlateChange` clears the raw override and serializes the Slate tree;
3. reload after revision conflict clears the override and exposes server Markdown;
4. path change cannot drain an old raw body into the new page;
5. encrypted pages encrypt the raw override through the existing encryption branch rather than sending plaintext.

- [ ] **Step 5: Complete the generation-safe implementation**

Reuse the existing generation and lifecycle refs. Do not introduce a second mutation or debounce. The setter is only another producer of the same body-dirty state; `doSave` remains the sole persistence path.

- [ ] **Step 6: Run hook tests, full editor hook regressions, typecheck, and lint**

Run:

```bash
bun --cwd ui run test src/editor/__tests__/usePageEditor.raw-body.test.tsx src/editor/__tests__/usePageEditor.encryption.test.tsx
bun --cwd ui run typecheck
bun --cwd ui x biome lint src/editor/usePageEditor.ts src/editor/__tests__/usePageEditor.raw-body.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the page-editor contract**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/editor/__tests__/usePageEditor.raw-body.test.tsx
git commit -m "feat(ui): support exact markdown body updates"
```

---

### Task 5: Dedicated recipe Folio read/edit experience

**Files:**
- Create: `ui/src/components/codex/recipe/RecipeFolioBody.tsx`
- Create: `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx:1-46,81-225,320-479`
- Create: `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`

**Interfaces:**
- Consumes: Task 2 `bodyPresentation: "recipe"`; Task 3 `parseRecipeMarkdown`, `serializeRecipeMarkdown`, `RecipeDocument`; Task 4 `setBodyMarkdown`; existing `PageEditorHeader`, `ReadOnlyPageHeader`, `SaveIndicator`, `SlateEditor`, React Aria controls, and revision-conflict state.
- Produces:

```ts
export type RecipeFolioBodyProps = {
  document: RecipeDocument;
  mode: "read" | "edit";
  onModeChange: (mode: "read" | "edit") => void;
  onDocumentChange: (document: RecipeDocument) => void;
};
```

Folio calls `parseRecipeMarkdown` once in `useMemo`. A successful result passes `result.value` to `RecipeFolioBody`; a failed result renders the existing `SlateEditor` with the preservation notice. `RecipeFolioBody` never parses or serializes Markdown.

- [ ] **Step 1: Use the frontend-design skill to translate the approved structure into existing Vessel patterns**

Before JSX, read `skill://frontend-design` and inspect the established Read/Edit control and React Aria reorder/button patterns. Keep the approved information architecture; this step decides spacing, responsive stacking, focus treatment, and control choice, not feature scope.

- [ ] **Step 2: Write failing recipe body read-view tests**

Render a parsed document and assert accessible output includes description, an `Ingredients` region/list, ordered `Steps`, and rendered bold notes. Assert ingredient rows are not checkboxes and have no persisted completion affordance.

- [ ] **Step 3: Run the component test and observe module-not-found failure**

Run:

```bash
bun --cwd ui run test src/components/codex/recipe/RecipeFolioBody.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement the read view**

Use semantic sections and lists:

```tsx
<section aria-labelledby={ingredientsId}>
  <h2 id={ingredientsId}>Ingredients</h2>
  <ul>{ingredients.map((ingredient, index) => <li key={`${index}:${ingredient}`}>{ingredient}</li>)}</ul>
</section>
<section aria-labelledby={stepsId}>
  <h2 id={stepsId}>Steps</h2>
  <ol>{steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}</ol>
</section>
```

Render notes through existing safe Markdown/Slate read-only primitives so emphasis, links, wikilinks, and other already-supported Markdown behave consistently. Do not enable raw HTML.

- [ ] **Step 5: Write failing structured-edit tests**

With `userEvent`, assert:

- description and notes edits call `onChange` with the updated `RecipeDocument`;
- ingredient/step add and remove controls have stable accessible names;
- moving the second ingredient/step up changes only array order;
- empty rows are omitted from serialized output;
- Read/Edit is a labelled React Aria radio/segmented control, not ad hoc buttons;
- keyboard activation works for add, remove, move up, and move down.

Use `onDocumentChange(document)` as the component-level callback; Folio owns serialization.

- [ ] **Step 6: Implement the structured editor with shared accessible controls**

Use controlled text areas/fields and existing shared button/segmented-radio components. Each collection row has text plus `Move up`, `Move down`, and `Remove` actions whose accessible name includes `ingredient N` or `step N`. Disable impossible moves. New rows receive focus. Do not implement drag-and-drop in this feature.

- [ ] **Step 7: Add failing Folio integration tests**

Build a `pageEditor` mock following `FolioAiConversation.test.tsx` and cover:

```ts
kind: "RECIPE",
bodyMarkdown: canonicalRecipeMarkdown,
setBodyMarkdown: vi.fn(),
```

Assert:

1. parseable recipe opens in Read mode with a read-only page header;
2. switching to Edit exposes structured fields;
3. changing a field calls `setBodyMarkdown(serializeRecipeMarkdown(next))` with exact Unicode bullet output;
4. `⌘S` calls the existing `saveNow` after a structured edit;
5. a malformed recipe shows the generic Slate editor and a notice containing “original Markdown is preserved”;
6. fallback editing never calls `setBodyMarkdown` until structured source exists;
7. a revision conflict remains visible and structured state is not reset;
8. changing `path` resets mode and reparses the new body;
9. locked encrypted Folios render `LockedFolio` before recipe controls.

- [ ] **Step 8: Run Folio tests and observe failure**

Run:

```bash
bun --cwd ui run test src/components/codex/__tests__/FolioRecipe.test.tsx
```

Expected: FAIL because Folio still renders the generic editor for `RECIPE`.

- [ ] **Step 9: Integrate recipe presentation into Folio**

Generalize conversation-only read-only state to kind-aware body state without changing conversation behavior:

```ts
const isRecipe = presentation.bodyPresentation === "recipe";
const recipeParse = useMemo(
  () => isRecipe ? parseRecipeMarkdown(editor.bodyMarkdown, editor.title) : null,
  [editor.bodyMarkdown, editor.title, isRecipe],
);
const recipeStructured = recipeParse?.ok === true;
const recipeReadOnly = recipeStructured && recipeMode === "read";
const folioReadOnly = conversationReadOnly || recipeReadOnly;
```

Reset `recipeMode` to `"read"` on path changes. Use `folioReadOnly` for header, kind/project static display, save-shortcut guard, and conflict visibility where appropriate. Preserve conversation-specific provider/Slate context.

For successful recipes, render `RecipeFolioBody`; on document changes call:

```ts
editor.setBodyMarkdown(serializeRecipeMarkdown(nextDocument));
```

For failed recipes, render the current generic `SlateEditor` plus a non-blocking alert. Do not call `setBodyMarkdown` during parse, mount, kind assignment, or fallback rendering.

- [ ] **Step 10: Run focused UI tests, typecheck, and lint**

Run:

```bash
bun --cwd ui run test src/components/codex/recipe/RecipeFolioBody.test.tsx src/components/codex/__tests__/FolioRecipe.test.tsx src/components/codex/__tests__/FolioAiConversation.test.tsx
bun --cwd ui run typecheck
bun --cwd ui x biome lint src/components/codex/recipe/RecipeFolioBody.tsx src/components/codex/recipe/RecipeFolioBody.test.tsx src/components/codex/Folio.tsx src/components/codex/__tests__/FolioRecipe.test.tsx
```

Expected: PASS, including unchanged AI conversation behavior.

- [ ] **Step 11: Commit the structured Folio**

```bash
git add ui/src/components/codex/recipe/RecipeFolioBody.tsx ui/src/components/codex/recipe/RecipeFolioBody.test.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/FolioRecipe.test.tsx
git commit -m "feat(ui): add structured recipe folio"
```

---

### Task 6: Recipe guide, complete verification, and integration

**Files:**
- Create: `ui/src/docs/content/recipes.mdx`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/registry.test.ts`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`
- Modify only if verification exposes a real defect: files owned by Tasks 1-5

**Interfaces:**
- Consumes: the complete implemented recipe contract.
- Produces: searchable in-app Recipes documentation; complete gate evidence; browser evidence; reviewed commits merged to `develop`.

- [ ] **Step 1: Add failing docs registry and MDX smoke assertions**

Update the expected Features hierarchy to:

```ts
["Features", ["bases", "books-and-reading", "recipes"]]
```

Assert `getDocPage("recipes")` has title `Recipes`. In the MDX smoke test, render the guide and assert headings named `Recipe format`, `Structured editing`, and `When Clepsydra falls back to Markdown`.

- [ ] **Step 2: Run docs tests and observe failure**

Run:

```bash
bun --cwd ui run test src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx
```

Expected: FAIL because the guide and registry entry do not exist.

- [ ] **Step 3: Write and register the Recipes guide**

Create MDX metadata:

```tsx
export const meta = {
  slug: "recipes",
  title: "Recipes",
  description: "Create, file, and edit structured recipe Folios without giving up portable Markdown."
}
```

Document:

- assigning `RECIPE` and canonical `recipes/` filing;
- the demonstrated `INGREDIENTS` / `•` / `STEPS` / numbered rows / `NOTES` body;
- accepted standard-Markdown headings and lists;
- title being page metadata rather than body text;
- deterministic canonical output after structured save;
- opaque ingredient/step strings and the absence of unit conversion;
- generic fallback preserving unsupported Markdown.

Import the raw source and lazy MDX component in `registry.ts`; add it after Books and Reading in the Features group.

- [ ] **Step 4: Run docs and focused feature tests**

Run:

```bash
bun --cwd ui run test src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx
bun --cwd ui run test src/recipe/recipeCodec.test.ts src/editor/__tests__/usePageEditor.raw-body.test.tsx src/components/codex/recipe/RecipeFolioBody.test.tsx src/components/codex/__tests__/FolioRecipe.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```bash
git add ui/src/docs/content/recipes.mdx ui/src/docs/registry.ts ui/src/docs/registry.test.ts ui/src/docs/mdx-smoke.test.tsx
git commit -m "docs(ui): add recipe folio guide"
```

- [ ] **Step 6: Run complete Rust verification gates**

Run separately and record each result:

```bash
cargo fmt --check
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
```

Expected: PASS for all four commands.

- [ ] **Step 7: Run complete UI verification gates**

Run separately and record each result:

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
bun --cwd ui run build
```

Expected: PASS for all four commands.

- [ ] **Step 8: Run the application and smoke-test the complete recipe path in a real browser**

Use the harness process manager to launch Clepsydra against a disposable initialized vault and wait for both log/port readiness. Use the browser tool, not component tests, for these observations:

1. Create a page with kind `RECIPE`; observe its path under `recipes/`.
2. Enter description, two ingredients, two steps, and Markdown notes in structured Edit mode.
3. Reorder one ingredient and one step using keyboard-operable controls.
4. Save, close, and reopen; observe canonical content in the dedicated Read view.
5. Inspect the persisted page and confirm normal frontmatter has `type = "RECIPE"`, title appears only in metadata, body uses Unicode bullets and sequential step numbers.
6. Create/open a standard-Markdown recipe; observe structured Read mode; enter Edit and save; observe normalization to the demonstrated convention only after that explicit edit/save.
7. Open a malformed `RECIPE`; observe the preservation notice and generic Markdown editor; save an ordinary source edit and confirm no content disappears.
8. At a narrow viewport, observe description, ingredients, steps, notes, and controls remain readable and keyboard focus remains visible.

Stop the disposable application process after the smoke test.

- [ ] **Step 9: Perform final two-stage review**

Dispatch the required reviewers against the complete branch:

1. spec-compliance reviewer checks every acceptance criterion in `docs/superpowers/specs/2026-08-11-recipe-kind-design.md` against code and evidence;
2. code-quality reviewer checks correctness, data-loss risks, accessibility, concurrency, allocations, duplication, and project conventions.

Fix every high-confidence issue, rerun the directly affected focused test, then rerun all verification gates from Steps 6-7 if production code changed.

- [ ] **Step 10: Commit any review fixes without sweeping user changes**

Stage only files changed for confirmed review findings and commit with a message describing the actual fix. If no fix is required, do not create an empty commit.

- [ ] **Step 11: Integrate into `develop`**

Invoke `superpowers:finishing-a-development-branch`. Confirm the worktree branch contains only the design commit plus recipe implementation/docs commits, merge it into `develop`, and rerun the shortest integration proof that exercises the merged result:

```bash
cargo test vault::kind::tests --lib
bun --cwd ui run test src/recipe/recipeCodec.test.ts src/components/codex/__tests__/FolioRecipe.test.tsx
```

Expected: PASS on `develop`. Report commit hashes, complete gate results, and browser observations.
