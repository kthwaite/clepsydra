# Recipe Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RECIPE pages open pre-sectioned, write portable h2/`-` Markdown, accept `###` component groups and multi-line steps, and let a whole ingredient list be pasted in one go.

**Architecture:** All recipe format knowledge stays in the frontend codec at `ui/src/recipe/recipeCodec.ts`. The backend gains one constant — a three-heading scaffold body written when a RECIPE page is created without one. A new `ui/src/recipe/recipeText.ts` owns the textarea↔items conversion used by the edit view, keeping paste normalisation out of both the codec and the component. Tasks are ordered so the model change (flat arrays → group arrays) lands after the edit view has already been reshaped, which keeps every intermediate commit green.

**Tech Stack:** TypeScript, React 19, react-aria-components, Vitest + Testing Library, Biome; Rust 2024, Axum 0.8, axum-test.

**Spec:** `docs/plans/2026-08-23-recipe-authoring.md` — read it before starting. It defines the on-disk format, the codec rules, and the decisions behind them.

## Global Constraints

- Path alias `#/` maps to `ui/src/`. Never use relative imports across directories.
- Frontend commands run from `ui/`: `cd ui && bun run <script>`. `bun --cwd ui run <script>` prints usage instead of running — do not use it.
- `develop` is **not** lint-clean repo-wide (~175 pre-existing `bun run lint` errors). Never run `biome check --write` across the repo. Lint only the paths you touched: `cd ui && bunx biome lint src/recipe src/components/codex/recipe`.
- The only pre-existing lint error in the recipe paths is `useExhaustiveDependencies` at `RecipeFolioBody.tsx:66`. Task 4 deletes that hook, after which those paths must be lint-clean and must stay so.
- Never run `cargo fmt` repo-wide; `develop` has 22 unformatted Rust files. Format only files you edited: `cargo fmt -- src/api/pages.rs`.
- Ingredients and steps are **opaque strings**. Never parse quantities, units, or temperatures.
- Every task ends with a commit. Commit subjects use the repo's `type(scope): Sentence case` style, e.g. `feat(recipes): Write h2 section headings`.
- Work on a branch off `develop`: `git switch -c feature/recipe-authoring develop`.

## File Structure

| File | Responsibility |
| --- | --- |
| `ui/src/recipe/recipeCodec.ts` | Parse and serialise a recipe body. The only place that knows the on-disk format. |
| `ui/src/recipe/recipeText.ts` | **New.** Convert between a textarea's text and an item list. Strips pasted list markers. Knows nothing about sections or files. |
| `ui/src/components/codex/recipe/RecipeFolioBody.tsx` | Read and edit views over a `RecipeDocument`. Owns no format knowledge. |
| `ui/src/components/codex/Folio.tsx` | Chooses structured vs fallback presentation; owns the fallback notice copy. |
| `src/api/pages.rs` | Writes the scaffold body when a RECIPE page is created without one. |
| `ui/src/docs/content/recipes.mdx` | Reader-facing documentation of the format and the editor. |

---

### Task 1: Write h2 section headings

Switch the serialiser from the bare-marker `•` form to `## Ingredients` / `-` / `1.`. The parser already reads that form, so this is serialisation plus expectation updates. No type changes.

**Files:**
- Modify: `ui/src/recipe/recipeCodec.ts` (`serializeRecipeMarkdown`, ~line 205 to end)
- Test: `ui/src/recipe/recipeCodec.test.ts`
- Test: `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx` (last test only)
- Test: `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `serializeRecipeMarkdown(document: RecipeDocument): string` now emits h2 sections. `RecipeDocument` is unchanged: `{ description: string; ingredients: string[]; steps: string[]; notesMarkdown: string }`.

- [ ] **Step 1: Write the failing test**

Add to the `describe("serializeRecipeMarkdown", …)` block in `ui/src/recipe/recipeCodec.test.ts`:

```ts
  it("emits h2 sections with standard list markers", () => {
    const serialized = serializeRecipeMarkdown({
      description: "Clear broth. Makes four bowls.",
      ingredients: ["1 whole chicken", "2 onions"],
      steps: ["Char the onions.", "Simmer the chicken."],
      notesMarkdown: "**Batch-friendly**: Freeze the broth.",
    });

    expect(serialized).toBe(`Clear broth. Makes four bowls.

## Ingredients

- 1 whole chicken
- 2 onions

## Steps

1. Char the onions.
2. Simmer the chicken.

## Notes

**Batch-friendly**: Freeze the broth.
`);
    expect(serialized).not.toContain("•");
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  it("emits bare headings for sections that hold only empty rows", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredients: [" ", "\t"],
        steps: ["\t "],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n## Steps\n\n## Notes\n");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/recipe/recipeCodec.test.ts`
Expected: FAIL — the serialiser still emits `INGREDIENTS` and `• `.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `serializeRecipeMarkdown` in `ui/src/recipe/recipeCodec.ts`:

```ts
/** `## Name` alone when the section is empty, `## Name` + blank line + block
 * otherwise. Empty sections must still emit their heading so the body keeps
 * parsing. */
const serializeSection = (heading: string, block: string): string =>
  block.length > 0 ? `## ${heading}\n\n${block}` : `## ${heading}`;

export function serializeRecipeMarkdown(document: RecipeDocument): string {
  const description = joinMarkdown(
    normalizeLineEndings(document.description).split("\n"),
  );
  const ingredients = document.ingredients
    .filter((ingredient) => ingredient.trim().length > 0)
    .map((ingredient) => `- ${normalizeLineEndings(ingredient)}`)
    .join("\n");
  const steps = document.steps
    .filter((step) => step.trim().length > 0)
    .map((step, index) => `${index + 1}. ${normalizeLineEndings(step)}`)
    .join("\n");
  const notes = joinMarkdown(
    normalizeLineEndings(document.notesMarkdown).split("\n"),
  );

  const sections = [
    ...(description.length > 0 ? [description] : []),
    serializeSection("Ingredients", ingredients),
    serializeSection("Steps", steps),
    serializeSection("Notes", notes),
  ];

  return `${sections.join("\n\n")}\n`;
}
```

- [ ] **Step 4: Update the existing expectations that named the old format**

Four assertions elsewhere still expect the bare-marker form.

In `ui/src/recipe/recipeCodec.test.ts`:

1. Delete the old `it("emits the deterministic demonstrated format without a title", …)` and `it("always emits all markers for sections containing only empty rows", …)` — Step 1's two tests replace them.
2. In `it("filters rows by trimmed emptiness without changing nonblank values", …)`, the expected serialisation changes. **The existing string carries deliberate trailing whitespace on two lines — preserve it.** Replace the `expect(serialized).toBe(…)` argument with:

```ts
      [
        "**Fast** broth.",
        "",
        "Second paragraph.",
        "",
        "## Ingredients",
        "",
        "- **2** onions (sliced)  ", // two trailing spaces, deliberate
        "",
        "## Steps",
        "",
        "1. Heat to 180°C — don't boil.  ", // two trailing spaces, deliberate
        "2. Serve.",
        "",
        "## Notes",
        "",
        "Use `fresh` herbs.",
        "",
      ].join("\n"),
```

   and in the same test change the re-parse expectation `sourceFormat: "example"` to `sourceFormat: "markdown"`.
3. In `it("round-trips marker-shaped Markdown inside Notes as notes content", …)` change `sourceFormat: "example"` to `sourceFormat: "markdown"`. The value is unchanged: the parser stops scanning at the `## Notes` marker, so the marker-shaped lines inside the notes stay notes content.
4. In `it("round-trips standard Markdown through the canonical demonstrated format", …)` change `sourceFormat: "example"` to `sourceFormat: "markdown"`, and rename it to `"round-trips standard Markdown through the canonical h2 format"`.

In `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`, the last test's expected string becomes:

```ts
    expect(serialized).toHaveBeenLastCalledWith(
      "A bright, weeknight pasta.\n\n## Ingredients\n\n- 200 g spaghetti\n- 1 lemon\n- 30 g parmesan\n\n## Steps\n\n1. Boil the pasta.\n2. Toss with lemon and parmesan.\n\n## Notes\n\nServe with **black pepper** and [[salad]].\n",
    );
```

In `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`, the second `toHaveBeenLastCalledWith` of `it("switches to structured fields and writes exact canonical Markdown", …)` becomes:

```ts
    expect(editor.setBodyMarkdown).toHaveBeenLastCalledWith(
      "A deeper dish.\n\n## Ingredients\n\n- one lemon\n- 200 g pasta\n\n## Steps\n\n1. Boil the pasta.\n2. Toss and serve.\n\n## Notes\n\nFinish with **pepper**.\n",
    );
```

Leave `canonicalRecipeMarkdown` at the top of that file in its bare-marker form — it is *input*, and it must keep proving that legacy bodies still parse.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && bun run test src/recipe src/components/codex`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
cd ui && bun run typecheck && bunx biome lint src/recipe src/components/codex/recipe && bun run test
cd .. && git add ui/src/recipe ui/src/components/codex && git commit -m "feat(recipes): Write h2 section headings and standard list markers"
```

`bunx biome lint` still reports the pre-existing `RecipeFolioBody.tsx:66` error. That is the documented baseline; Task 4 removes it.

---

### Task 2: Scaffold a new recipe body on the server

A RECIPE page created without a body gets the three headings, so every creation path — INTAKE modal, `vault_create_page`, CLI — produces a page that opens structured.

**Files:**
- Modify: `src/api/pages.rs` (`create_page`, the `let page_body = …` line at ~761)
- Test: `tests/api_test.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: a RECIPE page created with no body has body `"## Ingredients\n\n## Steps\n\n## Notes\n"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn create_recipe_page_without_body_writes_the_section_scaffold() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/pages/recipes/scaffold.md")
        .json(&serde_json::json!({ "title": "Scaffold", "kind": "RECIPE" }))
        .await;
    res.assert_status(StatusCode::CREATED);

    let res = server.get("/api/vault/pages/recipes/scaffold.md").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["body"], "## Ingredients\n\n## Steps\n\n## Notes\n");
}

#[tokio::test]
async fn create_recipe_page_keeps_a_supplied_body() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/pages/recipes/supplied.md")
        .json(&serde_json::json!({
            "title": "Supplied",
            "kind": "RECIPE",
            "body": "Already written.\n"
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    let res = server.get("/api/vault/pages/recipes/supplied.md").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["body"], "Already written.\n");
}

#[tokio::test]
async fn create_non_recipe_page_without_body_stays_empty() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/pages/notes/plain.md")
        .json(&serde_json::json!({ "title": "Plain", "kind": "NOTE" }))
        .await;
    res.assert_status(StatusCode::CREATED);

    let res = server.get("/api/vault/pages/notes/plain.md").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["body"], "");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test api_test recipe_page`
Expected: FAIL — `create_recipe_page_without_body_writes_the_section_scaffold` asserts `""` != the scaffold. The other two should already pass; that is fine, they are regression guards.

- [ ] **Step 3: Write minimal implementation**

In `src/api/pages.rs`, add near the other module constants:

```rust
/// Body written for a RECIPE page created without one: the three canonical
/// section headings. An empty body would open in the raw-Markdown fallback,
/// because the codec needs all three sections present to read a recipe.
const RECIPE_SCAFFOLD: &str = "## Ingredients\n\n## Steps\n\n## Notes\n";
```

and replace the `let page_body = body.body.unwrap_or_default();` line in `create_page` with:

```rust
    let page_body = body.body.unwrap_or_default();
    let page_body = if page_body.trim().is_empty()
        && matches!(meta.kind, Some(crate::vault::kind::Kind::Recipe))
    {
        RECIPE_SCAFFOLD.to_string()
    } else {
        page_body
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test api_test recipe_page && cargo test --test api_test non_recipe_page`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cargo fmt -- src/api/pages.rs && cargo clippy --all-targets -- -D warnings && cargo test
git add src/api/pages.rs tests/api_test.rs && git commit -m "feat(recipes): Scaffold section headings when creating a recipe page"
```

---

### Task 3: An empty recipe body opens structured

Pages created before Task 2, and pages assigned RECIPE after the fact, have empty bodies. Treat a whitespace-only body as an empty recipe rather than a parse failure. Implemented in the codec because that is the testable seam and every caller wants the same answer.

**Files:**
- Modify: `ui/src/recipe/recipeCodec.ts` (`parseRecipeMarkdown`, first lines)
- Test: `ui/src/recipe/recipeCodec.test.ts`
- Test: `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`

**Interfaces:**
- Consumes: `parseRecipeMarkdown` from Task 1 (unchanged signature).
- Produces: `parseRecipeMarkdown("", title)` returns `{ ok: true, sourceFormat: "markdown", value: { description: "", ingredients: [], steps: [], notesMarkdown: "" } }`.

- [ ] **Step 1: Write the failing tests**

In `ui/src/recipe/recipeCodec.test.ts`, inside `describe("parseRecipeMarkdown", …)`:

```ts
  it.each(["", "   ", "\n\n", "\r\n \r\n"])(
    "reads a blank body (%j) as an empty recipe",
    (source) => {
      expect(parseRecipeMarkdown(source, "Untitled recipe")).toEqual({
        ok: true,
        sourceFormat: "markdown",
        value: {
          description: "",
          ingredients: [],
          steps: [],
          notesMarkdown: "",
        },
      });
    },
  );

  it("serialises a blank body into the scaffold the server writes", () => {
    const parsed = parseRecipeMarkdown("", "Untitled recipe");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(serializeRecipeMarkdown(parsed.value)).toBe(
        "## Ingredients\n\n## Steps\n\n## Notes\n",
      );
    }
  });
```

In `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`, add a test that an empty body renders structured rather than the fallback notice. Follow the file's existing `renderFolio(pageEditor())` pattern; `pageEditor()` accepts overrides, so pass an empty body:

```ts
  it("opens an empty recipe body in the structured editor", () => {
    renderFolio(pageEditor({ bodyMarkdown: "" }));

    expect(screen.getByRole("region", { name: "Ingredients" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
```

`pageEditor` at `FolioRecipe.test.tsx:137` already accepts an overrides object and derives `initialValue` from `bodyMarkdown`, so no helper change is needed.

Add the regression guard the spec calls for in the same file — a recipe body carrying block ids must keep using the generic editor rather than the structured one:

```ts
  it("keeps a recipe with block ids in the generic editor", () => {
    renderFolio(
      pageEditor({
        bodyMarkdown:
          "## Ingredients\n\n- one lemon ^ab12cd34\n\n## Steps\n\n1. Boil.\n\n## Notes\n",
      }),
    );

    expect(screen.getByTestId("slate-editor")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Ingredients" })).toBeNull();
  });
```

If the block-id syntax in that assertion does not match what `containsBlockId` recognises, read `ui/src/components/codex/folio-utils.ts` (or wherever `containsBlockId` lives) and use its actual shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test src/recipe/recipeCodec.test.ts src/components/codex/__tests__/FolioRecipe.test.tsx`
Expected: FAIL with `reason: "missing-section"`.

- [ ] **Step 3: Write minimal implementation**

At the top of `parseRecipeMarkdown` in `ui/src/recipe/recipeCodec.ts`, before any other work:

```ts
export function parseRecipeMarkdown(
  body: string,
  pageTitle: string,
): RecipeParseResult {
  // A page created with no body, or one just assigned RECIPE, is an empty
  // recipe rather than a broken one — the editor should offer its fields, not
  // the preservation notice.
  if (body.trim() === "") {
    return {
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "",
        ingredients: [],
        steps: [],
        notesMarkdown: "",
      },
    };
  }

  const lines = trimBoundaryBlankLines(normalizeLineEndings(body).split("\n"));
  // …unchanged from here
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test src/recipe src/components/codex`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd ui && bun run typecheck && bunx biome lint src/recipe src/components/codex/recipe && bun run test
cd .. && git add ui/src && git commit -m "feat(recipes): Open an empty recipe body in the structured editor"
```

---

### Task 4: Textarea authoring for ingredients and steps

Replace the per-row inputs and their add/up/down/delete buttons with one textarea per collection, one item per line. This is what makes pasting a block from a website work. The model is still flat; grouping arrives in Task 6.

**Files:**
- Create: `ui/src/recipe/recipeText.ts`
- Create: `ui/src/recipe/recipeText.test.ts`
- Modify: `ui/src/components/codex/recipe/RecipeFolioBody.tsx` (edit view; read view untouched)
- Test: `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`

**Interfaces:**
- Consumes: `RecipeDocument` from Task 1.
- Produces:
  - `itemsFromText(text: string): string[]` — splits on newlines, strips a leading `-`, `*`, `+`, `•`, `N.`, or `N)` marker, trims, drops blank lines.
  - `textFromItems(items: string[]): string` — joins with newlines.
  - `RecipeTextArea` gains `placeholder?: string` and `onBlur?: () => void` props.

- [ ] **Step 1: Write the failing test for the text helpers**

Create `ui/src/recipe/recipeText.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { itemsFromText, textFromItems } from "#/recipe/recipeText";

describe("itemsFromText", () => {
  it("makes one item per line", () => {
    expect(itemsFromText("200 g spaghetti\n1 lemon")).toEqual([
      "200 g spaghetti",
      "1 lemon",
    ]);
  });

  it("strips list markers pasted from elsewhere", () => {
    expect(
      itemsFromText("- 200 g spaghetti\n* 1 lemon\n+ salt\n• pepper"),
    ).toEqual(["200 g spaghetti", "1 lemon", "salt", "pepper"]);
  });

  it("strips ordered markers in either punctuation", () => {
    expect(itemsFromText("1. Boil the pasta.\n2) Serve.")).toEqual([
      "Boil the pasta.",
      "Serve.",
    ]);
  });

  it("drops blank lines and normalises line endings", () => {
    expect(itemsFromText("1 lemon\r\n\r\n  \n30 g parmesan")).toEqual([
      "1 lemon",
      "30 g parmesan",
    ]);
  });

  it("leaves a quantity that merely starts with a digit alone", () => {
    expect(itemsFromText("2 onions\n1/2 tsp salt")).toEqual([
      "2 onions",
      "1/2 tsp salt",
    ]);
  });
});

describe("textFromItems", () => {
  it("round-trips through itemsFromText", () => {
    const items = ["200 g spaghetti", "1 lemon", "30 g parmesan"];
    expect(itemsFromText(textFromItems(items))).toEqual(items);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/recipe/recipeText.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the text helpers**

Create `ui/src/recipe/recipeText.ts`:

```ts
/** Conversion between a recipe textarea's text and its item list.
 *
 * The edit view is a plain textarea so a block of ingredients or steps can be
 * pasted straight from a web page. Whatever list marker came with that paste is
 * stripped here rather than being stored as part of the item — the codec owns
 * markers, items are opaque text. */

/** A leading unordered bullet or ordered marker, as pasted from elsewhere.
 * Requires trailing whitespace so a quantity like `1/2 tsp` is never mistaken
 * for a numbered item. */
const LEADING_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/u;

const normalizeLineEndings = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

export function itemsFromText(text: string): string[] {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(LEADING_MARKER, "").trim())
    .filter((line) => line.length > 0);
}

export function textFromItems(items: string[]): string {
  return items.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/recipe/recipeText.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component tests**

In `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`, **delete** every test that drives the row affordances — anything referencing `Add ingredient`, `Add step`, `Move ingredient`, `Move step`, `Remove ingredient`, `Remove step`, or a `Ingredient N` / `Step N` textbox. Replace them with:

```ts
  it("edits ingredients as one item per line", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const ingredients = screen.getByRole("textbox", { name: "Ingredients" });
    expect(ingredients).toHaveValue("200 g spaghetti\n1 lemon\n30 g parmesan");

    await user.clear(ingredients);
    await user.type(ingredients, "1 lemon{enter}sea salt");

    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ingredients: ["1 lemon", "sea salt"] }),
    );
  });

  it("accepts a pasted block of marked-up ingredients", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const ingredients = screen.getByRole("textbox", { name: "Ingredients" });
    await user.clear(ingredients);
    await user.paste("- 2 onions\n- 4 garlic cloves\n- 30 g ginger");

    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ingredients: ["2 onions", "4 garlic cloves", "30 g ginger"],
      }),
    );
  });

  it("re-renders the canonical text once the textarea loses focus", async () => {
    const user = userEvent.setup();
    render(<ControlledRecipe />);

    const ingredients = screen.getByRole("textbox", { name: "Ingredients" });
    await user.clear(ingredients);
    await user.paste("- 2 onions\n\n- 4 garlic cloves");
    expect(ingredients).toHaveValue("- 2 onions\n\n- 4 garlic cloves");

    await user.tab();
    expect(ingredients).toHaveValue("2 onions\n4 garlic cloves");
  });

  it("edits steps as one item per line", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const steps = screen.getByRole("textbox", { name: "Steps" });
    expect(steps).toHaveValue("Boil the pasta.\nToss with lemon and parmesan.");

    await user.clear(steps);
    await user.paste("1. Boil the pasta.\n2. Drain.");

    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ steps: ["Boil the pasta.", "Drain."] }),
    );
  });

  it("does not persist blank rows in canonical Markdown", async () => {
    const user = userEvent.setup();
    const serialized = vi.fn<(markdown: string) => void>();
    render(
      <ControlledRecipe
        onDocumentChange={(next) => serialized(serializeRecipeMarkdown(next))}
      />,
    );

    const ingredients = screen.getByRole("textbox", { name: "Ingredients" });
    await user.clear(ingredients);
    await user.paste("200 g spaghetti\n\n1 lemon\n\n30 g parmesan");

    expect(serialized).toHaveBeenLastCalledWith(
      "A bright, weeknight pasta.\n\n## Ingredients\n\n- 200 g spaghetti\n- 1 lemon\n- 30 g parmesan\n\n## Steps\n\n1. Boil the pasta.\n2. Toss with lemon and parmesan.\n\n## Notes\n\nServe with **black pepper** and [[salad]].\n",
    );
  });
```

Keep the read-view test and the segmented-control test exactly as they are.

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd ui && bun run test src/components/codex/recipe/RecipeFolioBody.test.tsx`
Expected: FAIL — no textbox named "Ingredients" exists in edit mode.

- [ ] **Step 7: Reshape the edit view**

In `ui/src/components/codex/recipe/RecipeFolioBody.tsx`:

Delete `RecipeCollectionEditor`, `focusContainedAction`, `PendingFocus`, the `pendingFocus`/`ingredientInputs`/`stepInputs`/`nextRowId`/`ingredientRowIds`/`stepRowIds` refs, the row-id bookkeeping loops, the focus `useEffect`, and `addRow` / `moveRow` / `removeRow`. Drop the now-unused imports (`ArrowDown`, `ArrowUp`, `Plus`, `Trash2`, `useEffect`, `useRef`, `Button`, `TextField`).

Add the draft-holding textarea. A draft of `null` means "show the canonical text"; typing sets a draft, blur drops it:

```tsx
/** A textarea whose value is the document's canonical text, except while the
 * reader is mid-edit. Re-deriving the value on every keystroke would move the
 * caret whenever normalisation changed the text, so the local draft governs
 * until focus leaves. */
function RecipeItemsTextArea({
  label,
  items,
  placeholder,
  rows,
  onItemsChange,
}: {
  label: string;
  items: string[];
  placeholder: string;
  rows: number;
  onItemsChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <RecipeTextArea
      label={label}
      hideLabel
      value={draft ?? textFromItems(items)}
      placeholder={placeholder}
      rows={rows}
      onChange={(value) => {
        setDraft(value);
        onItemsChange(itemsFromText(value));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
```

Give `RecipeTextArea` the two new props:

```tsx
function RecipeTextArea({
  label,
  value,
  onChange,
  onBlur,
  rows,
  placeholder,
  hideLabel = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  rows: number;
  placeholder?: string;
  hideLabel?: boolean;
}) {
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      aria-label={hideLabel ? label : undefined}
      className="group flex min-w-0 flex-col"
    >
```

and pass `placeholder={placeholder}` to the inner `<TextArea>`. Keep the existing `<Label>` and `<TextArea>` class strings untouched — they carry the Vessel styling.

Replace the two `RecipeCollectionEditor` usages in the edit branch with sections that keep the existing heading markup:

```tsx
          <section aria-labelledby={ingredientsId} className="grid gap-3">
            <h2
              id={ingredientsId}
              className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
            >
              Ingredients
            </h2>
            <RecipeItemsTextArea
              label="Ingredients"
              items={document.ingredients}
              placeholder="200g flour"
              rows={8}
              onItemsChange={(ingredients) =>
                onDocumentChange({ ...document, ingredients })
              }
            />
          </section>

          <section aria-labelledby={stepsId} className="grid gap-3">
            <h2
              id={stepsId}
              className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
            >
              Steps
            </h2>
            <RecipeItemsTextArea
              label="Steps"
              items={document.steps}
              placeholder="what to do first"
              rows={10}
              onItemsChange={(steps) => onDocumentChange({ ...document, steps })}
            />
          </section>
```

Add the two remaining placeholders: `placeholder="what the dish is, yield, timing"` on the Description textarea and `placeholder="substitutions, make-ahead, storage"` on the Notes textarea.

Update the imports at the top: `import { useId, useState } from "react";` and `import { itemsFromText, textFromItems } from "#/recipe/recipeText";`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd ui && bun run test src/components/codex src/recipe`
Expected: PASS.

- [ ] **Step 9: Gates and commit**

```bash
cd ui && bun run typecheck && bunx biome lint src/recipe src/components/codex/recipe && bun run test
cd .. && git add ui/src && git commit -m "feat(recipes): Author ingredients and steps in paste-friendly textareas"
```

`bunx biome lint` on those paths must now be **clean** — the deleted `useEffect` was the only pre-existing error there.

---

### Task 5: Multi-line steps

A step becomes a lead line plus its indented continuation lines, kept as one opaque string. This is what makes `double-black-bean-stew` parse. Ingredients stay single-line.

**Files:**
- Modify: `ui/src/recipe/recipeCodec.ts` (split `parseListLines`; step serialisation)
- Modify: `ui/src/recipe/recipeText.ts` (add step-aware helpers)
- Modify: `ui/src/components/codex/recipe/RecipeFolioBody.tsx` (steps textarea uses the step helpers)
- Test: `ui/src/recipe/recipeCodec.test.ts`, `ui/src/recipe/recipeText.test.ts`, `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`

**Interfaces:**
- Consumes: `itemsFromText` / `textFromItems` from Task 4.
- Produces:
  - `stepsFromText(text: string): string[]` — an unindented line starts a step, indented lines continue it; continuation lines are dedented by their common minimum indent.
  - `textFromSteps(steps: string[]): string` — continuation lines indented two spaces, no numbers rendered.
  - Codec: a parsed step may contain `\n`; serialisation indents continuation lines by the width of the step's own marker.

- [ ] **Step 1: Write the failing codec tests**

In `ui/src/recipe/recipeCodec.test.ts`:

```ts
  it("keeps indented continuation lines as part of their step", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- 2 shallots

## Steps

1. Start the aromatics
   Heat the oil over medium heat.
   Add shallots and sauté until softened.
2. Add the garlic
   Cook for about 1 minute.

## Notes
`,
        "Stew",
      ),
    ).toMatchObject({
      ok: true,
      value: {
        steps: [
          "Start the aromatics\nHeat the oil over medium heat.\nAdd shallots and sauté until softened.",
          "Add the garlic\nCook for about 1 minute.",
        ],
      },
    });
  });

  it("preserves indentation relative to a step's shallowest continuation", () => {
    const parsed = parseRecipeMarkdown(
      `## Ingredients

- salt

## Steps

1. Season
     deeply indented
   shallower line

## Notes
`,
      "Seasoning",
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: { steps: ["Season\n  deeply indented\nshallower line"] },
    });
  });

  it("keeps a blank line inside a step and drops trailing blanks", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- salt

## Steps

1. Rest the dough

   Come back in an hour.

2. Bake

## Notes
`,
        "Dough",
      ),
    ).toMatchObject({
      ok: true,
      value: { steps: ["Rest the dough\n\nCome back in an hour.", "Bake"] },
    });
  });

  it("indents continuation lines under their own step marker", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredients: [],
        steps: ["Start\nThen this.", "Finish"],
        notesMarkdown: "",
      }),
    ).toBe(
      "## Ingredients\n\n## Steps\n\n1. Start\n   Then this.\n2. Finish\n\n## Notes\n",
    );
  });

  it("accepts a bullet character in the heading format", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

• 2 onions

## Steps

1. Season.

## Notes
`,
        "Recipe",
      ),
    ).toMatchObject({ ok: true, value: { ingredients: ["2 onions"] } });
  });

  it("round-trips a multi-line step", () => {
    const document = {
      description: "",
      ingredients: ["salt"],
      steps: ["Start the aromatics\nHeat the oil.\n\nWait.", "Serve"],
      notesMarkdown: "",
    };

    expect(
      parseRecipeMarkdown(serializeRecipeMarkdown(document), "Recipe"),
    ).toEqual({ ok: true, sourceFormat: "markdown", value: document });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test src/recipe/recipeCodec.test.ts`
Expected: FAIL — continuation lines currently produce `unsupported-content`.

- [ ] **Step 3: Split the list parser**

In `ui/src/recipe/recipeCodec.ts`, keep the existing `parseListLines` for ingredients but rename it `parseIngredientLines` with the pattern and reason fixed:

```ts
const parseIngredientLines = (lines: string[]): ListParseResult => {
  const values: string[] = [];
  let hasInvalidItem = false;
  let hasUnsupportedStructure = false;
  let hasUnrecognizedContent = false;

  for (const line of lines) {
    if (line.trim() === "") continue;

    const match = line.match(/^[-*+•]\s+(.+)$/u);
    const value = match?.[1];
    if (value !== undefined) {
      if (/^\[[ xX]\](?:\s|$)/u.test(value)) hasUnsupportedStructure = true;
      else values.push(value);
      continue;
    }

    if (/^\s/u.test(line)) hasUnsupportedStructure = true;
    else if (/^(?:•|[-*+]|\d)/u.test(line)) hasInvalidItem = true;
    else hasUnrecognizedContent = true;
  }

  return finishList(
    values,
    "invalid-ingredient",
    hasInvalidItem,
    hasUnsupportedStructure,
    hasUnrecognizedContent,
  );
};
```

Add the shared verdict helper, preserving today's precedence exactly:

```ts
const finishList = (
  values: string[],
  invalidReason: "invalid-ingredient" | "invalid-step",
  hasInvalidItem: boolean,
  hasUnsupportedStructure: boolean,
  hasUnrecognizedContent: boolean,
): ListParseResult => {
  if (hasInvalidItem || (values.length === 0 && hasUnrecognizedContent)) {
    return { ok: false, reason: invalidReason };
  }
  if (hasUnsupportedStructure || hasUnrecognizedContent) {
    return { ok: false, reason: "unsupported-content" };
  }
  return { ok: true, values };
};
```

Add the step parser. It needs `dedent`, which the textarea helpers need too — define it **once**, exported from `ui/src/recipe/recipeText.ts` (Step 7 below), and import it here with `import { dedent } from "#/recipe/recipeText";`. Do not write a second copy in the codec.

```ts
const parseStepLines = (lines: string[]): ListParseResult => {
  const values: string[] = [];
  let lead: string | null = null;
  let continuation: string[] = [];
  let pendingBlanks = 0;
  let hasInvalidItem = false;
  let hasUnsupportedStructure = false;
  let hasUnrecognizedContent = false;

  const flush = () => {
    if (lead === null) return;
    const text = [lead, ...dedent(continuation)].join("\n");
    values.push(text.replace(/\n+$/u, ""));
    lead = null;
    continuation = [];
    pendingBlanks = 0;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      if (lead !== null) pendingBlanks += 1;
      continue;
    }

    const marker = line.match(/^\d+[.)]\s+(.+)$/u);
    const value = marker?.[1];
    if (value !== undefined) {
      flush();
      if (/^\[[ xX]\](?:\s|$)/u.test(value)) hasUnsupportedStructure = true;
      else lead = value;
      continue;
    }

    if (/^\s/u.test(line)) {
      if (lead === null) {
        hasUnsupportedStructure = true;
        continue;
      }
      for (let blank = 0; blank < pendingBlanks; blank += 1) {
        continuation.push("");
      }
      pendingBlanks = 0;
      continuation.push(line);
      continue;
    }

    if (/^(?:•|[-*+]|\d)/u.test(line)) hasInvalidItem = true;
    else hasUnrecognizedContent = true;
  }
  flush();

  return finishList(
    values,
    "invalid-step",
    hasInvalidItem,
    hasUnsupportedStructure,
    hasUnrecognizedContent,
  );
};
```

Replace the two `parseListLines(...)` call sites in `parseRecipeMarkdown` with `parseIngredientLines(lines.slice(...))` and `parseStepLines(lines.slice(...))`, keeping the surrounding error-ordering logic untouched.

- [ ] **Step 4: Serialise the continuation lines**

In `serializeRecipeMarkdown`, replace the `steps` mapping with:

```ts
  const steps = document.steps
    .filter((step) => step.trim().length > 0)
    .map((step, index) => {
      const marker = `${index + 1}. `;
      const indent = " ".repeat(marker.length);
      const [lead = "", ...rest] = normalizeLineEndings(step).split("\n");
      return [
        `${marker}${lead}`,
        ...rest.map((line) => (line.trim() === "" ? "" : `${indent}${line}`)),
      ].join("\n");
    })
    .join("\n");
```

- [ ] **Step 5: Run codec tests to verify they pass**

Run: `cd ui && bun run test src/recipe/recipeCodec.test.ts`
Expected: PASS, including every pre-existing rejection case — `invalid-step`, `unsupported-content` for task-list steps, and the blank-line-spacing test.

- [ ] **Step 6: Write the failing text-helper tests**

Append to `ui/src/recipe/recipeText.test.ts`:

```ts
describe("stepsFromText", () => {
  it("starts a step at each unindented line", () => {
    expect(stepsFromText("Boil the pasta.\nDrain.")).toEqual([
      "Boil the pasta.",
      "Drain.",
    ]);
  });

  it("folds indented lines into the step above", () => {
    expect(
      stepsFromText("Start the aromatics\n  Heat the oil.\n  Add shallots.\nServe."),
    ).toEqual(["Start the aromatics\nHeat the oil.\nAdd shallots.", "Serve."]);
  });

  it("strips ordered markers pasted from elsewhere", () => {
    expect(stepsFromText("1. Boil.\n2) Drain.")).toEqual(["Boil.", "Drain."]);
  });

  it("round-trips through textFromSteps", () => {
    const steps = ["Start\nThen this.", "Finish"];
    expect(stepsFromText(textFromSteps(steps))).toEqual(steps);
  });

  it("renders no step numbers", () => {
    expect(textFromSteps(["Boil.", "Drain."])).toBe("Boil.\nDrain.");
  });
});
```

Extend the import at the top of that file to `import { itemsFromText, stepsFromText, textFromItems, textFromSteps } from "#/recipe/recipeText";`.

- [ ] **Step 7: Write the step text helpers**

Append to `ui/src/recipe/recipeText.ts`. `dedent` is exported because the codec imports it — it is the one place that decides how a step's indentation is interpreted.

```ts
const STEP_INDENT = "  ";

/** Strip the shallowest indent shared by a step's continuation lines, so
 * indentation *within* a step survives while its offset from the marker does
 * not. Blank lines carry no indent and stay blank. */
export const dedent = (lines: string[]): string[] => {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const shallowest = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(shallowest)));
};

/** An unindented line opens a step; indented lines belong to the step above.
 * Numbers are never rendered into the textarea, so any that arrive with a paste
 * are stripped rather than fought with. */
export function stepsFromText(text: string): string[] {
  const steps: string[] = [];
  let lead: string | null = null;
  let continuation: string[] = [];

  const flush = () => {
    if (lead === null) return;
    steps.push([lead, ...dedent(continuation)].join("\n").replace(/\n+$/u, ""));
    lead = null;
    continuation = [];
  };

  for (const line of normalizeLineEndings(text).split("\n")) {
    if (line.trim() === "") {
      if (lead !== null) continuation.push("");
      continue;
    }
    if (/^\s/u.test(line) && lead !== null) {
      continuation.push(line);
      continue;
    }
    flush();
    lead = line.replace(LEADING_MARKER, "").trim();
  }
  flush();

  return steps.filter((step) => step.trim().length > 0);
}

export function textFromSteps(steps: string[]): string {
  return steps
    .map((step) =>
      normalizeLineEndings(step)
        .split("\n")
        .map((line, index) =>
          index === 0 || line.trim() === "" ? line : `${STEP_INDENT}${line}`,
        )
        .join("\n"),
    )
    .join("\n");
}
```

- [ ] **Step 8: Point the steps textarea at the step helpers**

In `RecipeFolioBody.tsx`, give `RecipeItemsTextArea` a pair of converters instead of hard-coding the item ones:

```tsx
function RecipeItemsTextArea({
  label,
  items,
  placeholder,
  rows,
  toText,
  fromText,
  onItemsChange,
}: {
  label: string;
  items: string[];
  placeholder: string;
  rows: number;
  toText: (items: string[]) => string;
  fromText: (text: string) => string[];
  onItemsChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <RecipeTextArea
      label={label}
      hideLabel
      value={draft ?? toText(items)}
      placeholder={placeholder}
      rows={rows}
      onChange={(value) => {
        setDraft(value);
        onItemsChange(fromText(value));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
```

Pass `toText={textFromItems} fromText={itemsFromText}` for Ingredients and `toText={textFromSteps} fromText={stepsFromText}` for Steps. Update the import to pull all four helpers.

- [ ] **Step 9: Add the component test for a multi-line paste**

In `RecipeFolioBody.test.tsx`:

```ts
  it("keeps indented detail lines inside their step", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const steps = screen.getByRole("textbox", { name: "Steps" });
    await user.clear(steps);
    await user.paste("Start the aromatics\n  Heat the oil.\nServe.");

    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        steps: ["Start the aromatics\nHeat the oil.", "Serve."],
      }),
    );
  });
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd ui && bun run test src/recipe src/components/codex`
Expected: PASS.

- [ ] **Step 11: Gates and commit**

```bash
cd ui && bun run typecheck && bunx biome lint src/recipe src/components/codex/recipe && bun run test
cd .. && git add ui/src && git commit -m "feat(recipes): Support multi-line steps with continuation lines"
```

---

### Task 6: Component groups

`## Ingredients` and `## Steps` gain optional `###` groups. This is the model change, so the codec and both views move in one commit — the type cannot change in isolation.

**Files:**
- Modify: `ui/src/recipe/recipeCodec.ts` (types, marker resolution, group splitting, serialisation)
- Modify: `ui/src/components/codex/recipe/RecipeFolioBody.tsx` (read and edit views)
- Modify: `ui/src/components/codex/Folio.tsx` (`sourceFormat` literal at ~line 1137; fallback notice copy at ~line 1083)
- Test: `ui/src/recipe/recipeCodec.test.ts`, `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`, `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:

```ts
export type RecipeGroup = { name: string | null; items: string[] };

export type RecipeDocument = {
  description: string;
  ingredientGroups: RecipeGroup[];
  stepGroups: RecipeGroup[];
  notesMarkdown: string;
};
```

  **Invariant:** `groups[0].name === null` always — the unnamed lead group exists even when empty, and every group after it is named. `ingredients` and `steps` are gone; every consumer must move.

- [ ] **Step 1: Write the failing codec tests**

In `ui/src/recipe/recipeCodec.test.ts`, every existing expectation of `ingredients: [...]` / `steps: [...]` becomes `ingredientGroups: [{ name: null, items: [...] }]` / `stepGroups: [{ name: null, items: [...] }]`, and every `serializeRecipeMarkdown({...})` input moves to the new shape. Do that mechanically first, run the suite to confirm only the new cases fail, then add:

```ts
  it("reads h3 headings as component groups", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- 200g flour

### For the sauce

- 2 tomatoes
- 1 clove garlic

## Steps

1. Make the dough.

### For the sauce

1. Blanch the tomatoes.
2. Blend.

## Notes
`,
        "Pizza",
      ),
    ).toEqual({
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "",
        ingredientGroups: [
          { name: null, items: ["200g flour"] },
          { name: "For the sauce", items: ["2 tomatoes", "1 clove garlic"] },
        ],
        stepGroups: [
          { name: null, items: ["Make the dough."] },
          { name: "For the sauce", items: ["Blanch the tomatoes.", "Blend."] },
        ],
        notesMarkdown: "",
      },
    });
  });

  it("restarts step numbering in each group", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [{ name: null, items: [] }],
        stepGroups: [
          { name: null, items: ["Make the dough.", "Rest it."] },
          { name: "For the sauce", items: ["Blanch.", "Blend."] },
        ],
        notesMarkdown: "",
      }),
    ).toBe(
      "## Ingredients\n\n## Steps\n\n1. Make the dough.\n2. Rest it.\n\n### For the sauce\n\n1. Blanch.\n2. Blend.\n\n## Notes\n",
    );
  });

  it("emits a named group that holds no items", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [
          { name: null, items: [] },
          { name: "For the sauce", items: [] },
        ],
        stepGroups: [{ name: null, items: [] }],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n### For the sauce\n\n## Steps\n\n## Notes\n");
  });

  it("merges a group whose name is blank into the group before it", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [
          { name: null, items: ["flour"] },
          { name: "   ", items: ["salt"] },
        ],
        stepGroups: [{ name: null, items: [] }],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n- flour\n- salt\n\n## Steps\n\n## Notes\n");
  });

  it("treats a section name at group depth as a group, not a section", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- salt

## Steps

1. Season.

### Notes

1. Rest before serving.

## Notes

Keep this.
`,
        "Seasoning",
      ),
    ).toMatchObject({
      ok: true,
      value: {
        stepGroups: [
          { name: null, items: ["Season."] },
          { name: "Notes", items: ["Rest before serving."] },
        ],
        notesMarkdown: "Keep this.",
      },
    });
  });

  it.each([
    {
      name: "group heading at the wrong depth",
      source: `## Ingredients

- salt

#### For the sauce

- 2 tomatoes

## Steps

1. Season.

## Notes
`,
    },
    {
      name: "group heading with no name",
      source: `## Ingredients

- salt

###

- 2 tomatoes

## Steps

1. Season.

## Notes
`,
    },
    {
      name: "group heading in the legacy marker format",
      source: `INGREDIENTS
• salt
### For the sauce
• 2 tomatoes
STEPS
1. Season.
NOTES
`,
    },
  ] as const)("rejects a $name", ({ source }) => {
    expect(parseRecipeMarkdown(source, "Recipe")).toEqual({
      ok: false,
      reason: "unsupported-content",
    });
  });

  it.each([
    {
      name: "legacy bare markers",
      title: "Masoor Dal with Tadka-on-Demand",
      source: `A North Indian masoor dal.

INGREDIENTS
• 300 grams red split lentils, rinsed
• 1.5 liters water

STEPS
1. Start the lentils: put them in a heavy pot.
2. Build the base: heat the ghee.

NOTES
**Batch-friendly**: improves over three days.
`,
    },
    {
      name: "legacy markers under a duplicated title line",
      title: "Phở Gà (Hanoi-style Chicken Pho)",
      source: `Phở Gà (Hanoi-style Chicken Pho)
Clean, clear chicken broth.

INGREDIENTS
• 1.5 kilograms whole chicken

STEPS

1. Char the aromatics until blackened in patches.

NOTES
`,
    },
    {
      name: "headings with asterisk bullets and multi-line steps",
      title: "Double Black Bean Stew",
      source: `## Ingredients

* 1 tbsp neutral oil
* 2 shallots, finely sliced

## Steps

1. Start the aromatics
   Heat the oil in a wide frying pan over medium heat.
   Add shallots and sauté until softened.
2. Add the garlic
   Cook for about 1 minute.

## Notes

* Rinsing the beans keeps the salinity under control.
`,
    },
  ] as const)(
    "reads $name and is stable across a second round-trip",
    ({ title, source }) => {
      const parsed = parseRecipeMarkdown(source, title);
      expect(parsed).toMatchObject({ ok: true });
      if (!parsed.ok) return;

      const canonical = serializeRecipeMarkdown(parsed.value);
      expect(canonical).toContain("## Ingredients");
      expect(canonical).not.toContain("• ");
      expect(parseRecipeMarkdown(canonical, title)).toEqual({
        ok: true,
        sourceFormat: "markdown",
        value: parsed.value,
      });
    },
  );

  it("round-trips a grouped recipe", () => {
    const document = {
      description: "A composed dish.",
      ingredientGroups: [
        { name: null, items: ["200g flour"] },
        { name: "For the sauce", items: ["2 tomatoes"] },
      ],
      stepGroups: [
        { name: null, items: ["Make the dough.\nRest it."] },
        { name: "For the sauce", items: ["Blend."] },
      ],
      notesMarkdown: "Freezes well.",
    };

    expect(
      parseRecipeMarkdown(serializeRecipeMarkdown(document), "Recipe"),
    ).toEqual({ ok: true, sourceFormat: "markdown", value: document });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test src/recipe/recipeCodec.test.ts`
Expected: FAIL — type errors on `ingredientGroups` plus the new grouping cases.

- [ ] **Step 3: Change the types**

In `ui/src/recipe/recipeCodec.ts`:

```ts
export type RecipeGroup = { name: string | null; items: string[] };

/** `ingredientGroups[0]` and `stepGroups[0]` are always the unnamed lead group;
 * every group after it is named. A recipe with no components is a single lead
 * group. */
export type RecipeDocument = {
  description: string;
  ingredientGroups: RecipeGroup[];
  stepGroups: RecipeGroup[];
  notesMarkdown: string;
};
```

Update the blank-body early return from Task 3 to `ingredientGroups: [{ name: null, items: [] }], stepGroups: [{ name: null, items: [] }]`.

- [ ] **Step 4: Rewrite marker resolution**

Give example-format markers a depth of `0` so both formats compare the same way, then resolve the section depth from the first candidate:

```ts
type SectionMarker = {
  name: SectionName;
  format: SourceFormat;
  depth: number;
  index: number;
};

const parseSectionMarker = (
  line: string,
  index: number,
): SectionMarker | null => {
  const exampleMatch = line.match(/^(ingredients|steps|notes)$/i);
  if (exampleMatch?.[1]) {
    return {
      name: exampleMatch[1].toLowerCase() as SectionName,
      format: "example",
      depth: 0,
      index,
    };
  }

  const markdownMatch = line.match(/^(#{1,6})\s+(ingredients|steps|notes)\s*$/i);
  if (!markdownMatch?.[1] || !markdownMatch[2]) return null;

  return {
    name: markdownMatch[2].toLowerCase() as SectionName,
    format: "markdown",
    depth: markdownMatch[1].length,
    index,
  };
};
```

Replace the marker-collection loop and the missing/duplicate checks in `parseRecipeMarkdown` with:

```ts
  // The first marker fixes the format and, for Markdown, the section depth.
  // Anything at another depth is content — that is what lets `### Notes` inside
  // Steps be a group name rather than a section.
  const candidates: SectionMarker[] = [];
  let format: SourceFormat | null = null;
  let sectionDepth = 0;
  const seen = new Set<SectionName>();
  for (const [index, line] of lines.entries()) {
    const marker = parseSectionMarker(line, index);
    if (!marker) continue;
    candidates.push(marker);
    if (format === null) {
      format = marker.format;
      sectionDepth = marker.depth;
    }
    if (marker.format !== format || marker.depth !== sectionDepth) continue;
    seen.add(marker.name);
    // Stop before the notes prose, so marker-shaped lines inside it stay prose.
    if (marker.name === "notes" && seen.has("ingredients") && seen.has("steps")) {
      break;
    }
  }

  const accepted = candidates.filter(
    (marker) => marker.format === format && marker.depth === sectionDepth,
  );
  for (const name of sectionNames) {
    if (accepted.some((marker) => marker.name === name)) continue;
    return {
      ok: false,
      reason: candidates.some((marker) => marker.name === name)
        ? "mixed-format"
        : "missing-section",
    };
  }
  if (
    sectionNames.some(
      (name) => accepted.filter((marker) => marker.name === name).length > 1,
    )
  ) {
    return { ok: false, reason: "duplicate-section" };
  }

  const ingredientMarker = accepted.find((m) => m.name === "ingredients");
  const stepMarker = accepted.find((m) => m.name === "steps");
  const notesMarker = accepted.find((m) => m.name === "notes");
  if (!ingredientMarker || !stepMarker || !notesMarker) {
    return { ok: false, reason: "missing-section" };
  }
```

Keep the existing `section-order` check on those three markers. Delete the old `mixed-format` depth/format comparison — the resolution above subsumes it. `sourceFormat` is now `format ?? "markdown"`.

- [ ] **Step 5: Split each section region into groups**

```ts
type GroupRegion = { name: string | null; lines: string[] };

/** Split a section's lines on group headings one level below the section. */
const splitGroups = (
  lines: string[],
  format: SourceFormat,
  sectionDepth: number,
): GroupRegion[] | null => {
  const groups: GroupRegion[] = [{ name: null, lines: [] }];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s*(.*)$/u);
    if (!heading?.[1]) {
      groups[groups.length - 1]?.lines.push(line);
      continue;
    }
    // Groups exist only in the heading format; the legacy marker format is
    // read-only legacy and gains no new shapes.
    if (format === "example") return null;
    const name = (heading[2] ?? "").trim();
    if (heading[1].length !== sectionDepth + 1 || name === "") return null;
    groups.push({ name, lines: [] });
  }

  return groups;
};

const parseGroups = (
  lines: string[],
  format: SourceFormat,
  sectionDepth: number,
  parseItems: (lines: string[]) => ListParseResult,
):
  | { ok: true; groups: RecipeGroup[] }
  | { ok: false; reason: RecipeParseFailure } => {
  const regions = splitGroups(lines, format, sectionDepth);
  if (!regions) return { ok: false, reason: "unsupported-content" };

  const groups: RecipeGroup[] = [];
  for (const region of regions) {
    const parsed = parseItems(region.lines);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    groups.push({ name: region.name, items: parsed.values });
  }
  return { ok: true, groups };
};
```

Call it for both regions, preserving today's error ordering (an ingredient failure that is not `unsupported-content` is reported before a step failure; see the existing `if (!ingredients.ok && ingredients.reason !== "unsupported-content")` sequence and keep its shape).

- [ ] **Step 6: Serialise groups**

```ts
/** Enforce the lead-group invariant on the way out: the first group is always
 * unnamed, and a group whose name has been cleared merges into the one before
 * it rather than producing an unreadable body. */
const normalizeGroups = (groups: RecipeGroup[]): RecipeGroup[] => {
  const out: RecipeGroup[] = [{ name: null, items: [] }];
  for (const [index, group] of groups.entries()) {
    const name = group.name?.trim() ?? "";
    const items = group.items.filter((item) => item.trim().length > 0);
    if (index === 0 || name === "") {
      out[out.length - 1]?.items.push(...items);
      continue;
    }
    out.push({ name, items });
  }
  return out;
};

const serializeSection = (
  heading: string,
  groups: RecipeGroup[],
  block: (items: string[]) => string,
): string => {
  const [lead, ...named] = normalizeGroups(groups);
  const parts = [`## ${heading}`];

  const leadBlock = lead ? block(lead.items) : "";
  if (leadBlock.length > 0) parts.push(leadBlock);

  for (const group of named) {
    parts.push(`### ${group.name}`);
    const body = block(group.items);
    if (body.length > 0) parts.push(body);
  }

  return parts.join("\n\n");
};

const ingredientBlock = (items: string[]): string =>
  items.map((item) => `- ${normalizeLineEndings(item)}`).join("\n");

const stepBlock = (items: string[]): string =>
  items
    .map((step, index) => {
      const marker = `${index + 1}. `;
      const indent = " ".repeat(marker.length);
      const [lead = "", ...rest] = normalizeLineEndings(step).split("\n");
      return [
        `${marker}${lead}`,
        ...rest.map((line) => (line.trim() === "" ? "" : `${indent}${line}`)),
      ].join("\n");
    })
    .join("\n");
```

`serializeRecipeMarkdown` becomes description + the three sections joined with `\n\n` plus a final `\n`, with Notes still using the Task 1 `## Notes` + block form.

- [ ] **Step 7: Run codec tests to verify they pass**

Run: `cd ui && bun run test src/recipe/recipeCodec.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing view tests**

In `RecipeFolioBody.test.tsx`, move the `recipe` fixture to the new shape and add:

```ts
const grouped: RecipeDocument = {
  description: "A composed dish.",
  ingredientGroups: [
    { name: null, items: ["200g flour"] },
    { name: "For the sauce", items: ["2 tomatoes"] },
  ],
  stepGroups: [
    { name: null, items: ["Make the dough."] },
    { name: "For the sauce", items: ["Blend."] },
  ],
  notesMarkdown: "",
};

  it("renders group subheads and restarts numbering per group in read mode", () => {
    render(
      <RecipeFolioBody
        document={grouped}
        mode="read"
        onModeChange={vi.fn()}
        onDocumentChange={vi.fn()}
      />,
    );

    const steps = screen.getByRole("region", { name: "Steps" });
    expect(
      within(steps).getByRole("heading", { name: "For the sauce", level: 3 }),
    ).toBeVisible();
    expect(within(steps).getAllByRole("list")).toHaveLength(2);
  });

  it("adds a group and edits its items independently", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ControlledRecipe initial={grouped} onDocumentChange={onDocumentChange} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Add ingredient group" }),
    );
    const name = screen.getByRole("textbox", {
      name: "Ingredient group 2 name",
    });
    await user.type(name, "For the topping");

    const items = screen.getByRole("textbox", {
      name: "Ingredient group 2 items",
    });
    await user.paste("- 50g parmesan");

    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ingredientGroups: [
          { name: null, items: ["200g flour"] },
          { name: "For the sauce", items: ["2 tomatoes"] },
          { name: "For the topping", items: ["50g parmesan"] },
        ],
      }),
    );
  });

  it("merges a removed group's items into the group before it", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ControlledRecipe initial={grouped} onDocumentChange={onDocumentChange} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Remove ingredient group 1" }),
    );

    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ingredientGroups: [{ name: null, items: ["200g flour", "2 tomatoes"] }],
      }),
    );
  });
```

Group numbering in labels is 1-based over the **named** groups, so the first named group is "group 1".

- [ ] **Step 9: Reshape the read view**

Both collections now render a list per group, which is what restarts the step
numbering. Add the shared visibility rule and the group wrapper, then rewrite
`RecipeReadView`. Every class string below is copied from the current file — the
Vessel styling must not drift.

```tsx
/** The unnamed lead group is structural, not visible: hide it when it holds
 * nothing, so a fully grouped recipe shows no stray empty list. Named groups
 * always render — the heading tells the reader the component exists. */
const visibleGroups = (groups: RecipeGroup[]): RecipeGroup[] =>
  groups.filter((group, index) => index > 0 || group.items.length > 0);

function RecipeReadGroup({
  name,
  children,
}: {
  name: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      {name === null ? null : (
        <h3 className="cl-mono m-0 pt-4 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-mute">
          {name}
        </h3>
      )}
      {children}
    </>
  );
}
```

Replace the two `<section>` bodies inside the two-column grid of
`RecipeReadView`:

```tsx
        <section aria-labelledby={ingredientsId}>
          <h2
            id={ingredientsId}
            className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
          >
            Ingredients
          </h2>
          {visibleGroups(document.ingredientGroups).map((group, index) => (
            <RecipeReadGroup
              key={group.name ?? `ingredient-lead-${index}`}
              name={group.name}
            >
              <ul className="m-0 list-disc space-y-2 py-4 pl-5 marker:text-accent">
                {group.items.map((item, itemIndex) => (
                  <li key={`${itemIndex}:${item}`} className="pl-1 text-ink-2">
                    {item}
                  </li>
                ))}
              </ul>
            </RecipeReadGroup>
          ))}
        </section>

        <section aria-labelledby={stepsId}>
          <h2
            id={stepsId}
            className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
          >
            Steps
          </h2>
          {visibleGroups(document.stepGroups).map((group, index) => (
            <RecipeReadGroup
              key={group.name ?? `step-lead-${index}`}
              name={group.name}
            >
              <ol className="m-0 list-decimal space-y-4 py-4 pl-7 marker:font-heading marker:text-base marker:font-bold marker:text-accent">
                {group.items.map((item, itemIndex) => (
                  <li
                    key={`${itemIndex}:${item}`}
                    className="whitespace-pre-line pl-2 text-ink-2"
                  >
                    {item}
                  </li>
                ))}
              </ol>
            </RecipeReadGroup>
          ))}
        </section>
```

`whitespace-pre-line` is what makes a multi-line step's continuation lines break
where the author put them.

- [ ] **Step 10: Reshape the edit view**

Add one component that renders a whole collection — lead textarea, named groups,
Add group — and use it twice. It owns its own group operations, so the parent
only passes `groups` and `onGroupsChange`. Re-import `Button`, `TextField`,
`Plus`, and `Trash2`.

```tsx
function RecipeGroupsEditor({
  heading,
  headingId,
  singular,
  groupLabel,
  itemPlaceholder,
  rows,
  groups,
  toText,
  fromText,
  onGroupsChange,
}: {
  heading: string;
  headingId: string;
  /** Lowercase, for button copy: "Add ingredient group". */
  singular: "ingredient" | "step";
  /** Capitalised, for field labels: "Ingredient group 1 name". */
  groupLabel: "Ingredient" | "Step";
  itemPlaceholder: string;
  rows: number;
  groups: RecipeGroup[];
  toText: (items: string[]) => string;
  fromText: (text: string) => string[];
  onGroupsChange: (groups: RecipeGroup[]) => void;
}) {
  const [lead, ...named] = groups;

  const replace = (index: number, patch: Partial<RecipeGroup>) =>
    onGroupsChange(
      groups.map((group, candidate) =>
        candidate === index ? { ...group, ...patch } : group,
      ),
    );

  /** Removing a group keeps its items: they join the group above, so a misclick
   * never destroys written text. */
  const removeGroup = (index: number) => {
    const next = groups.map((group) => ({ ...group }));
    const [removed] = next.splice(index, 1);
    const target = next[index - 1];
    if (removed && target) target.items = [...target.items, ...removed.items];
    onGroupsChange(next);
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
        <h2
          id={headingId}
          className="cl-mono m-0 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
        >
          {heading}
        </h2>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => onGroupsChange([...groups, { name: "", items: [] }])}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add {singular} group
        </Button>
      </div>

      <RecipeItemsTextArea
        label={heading}
        items={lead?.items ?? []}
        placeholder={itemPlaceholder}
        rows={rows}
        toText={toText}
        fromText={fromText}
        onItemsChange={(items) => replace(0, { items })}
      />

      {named.map((group, offset) => {
        const index = offset + 1;
        return (
          <div
            key={`${singular}-group-${index}`}
            className="grid gap-2 border-l-2 border-rule-soft pl-3"
          >
            <div className="flex items-end justify-between gap-2">
              <TextField
                label={`${groupLabel} group ${index} name`}
                value={group.name ?? ""}
                onChange={(name) => replace(index, { name })}
                placeholder="for the sauce"
                className="min-w-0 flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${singular} group ${index}`}
                onPress={() => removeGroup(index)}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
            <RecipeItemsTextArea
              label={`${groupLabel} group ${index} items`}
              items={group.items}
              placeholder={itemPlaceholder}
              rows={rows}
              toText={toText}
              fromText={fromText}
              onItemsChange={(items) => replace(index, { items })}
            />
          </div>
        );
      })}
    </section>
  );
}
```

In the edit branch of `RecipeFolioBody`, the two Task 4/5 sections become:

```tsx
          <RecipeGroupsEditor
            heading="Ingredients"
            headingId={ingredientsId}
            singular="ingredient"
            groupLabel="Ingredient"
            itemPlaceholder="200g flour"
            rows={8}
            groups={document.ingredientGroups}
            toText={textFromItems}
            fromText={itemsFromText}
            onGroupsChange={(ingredientGroups) =>
              onDocumentChange({ ...document, ingredientGroups })
            }
          />

          <RecipeGroupsEditor
            heading="Steps"
            headingId={stepsId}
            singular="step"
            groupLabel="Step"
            itemPlaceholder="what to do first"
            rows={10}
            groups={document.stepGroups}
            toText={textFromSteps}
            fromText={stepsFromText}
            onGroupsChange={(stepGroups) =>
              onDocumentChange({ ...document, stepGroups })
            }
          />
```

The Description and Notes textareas keep the shape and placeholders they got in
Task 4.

- [ ] **Step 11: Update Folio**

In `ui/src/components/codex/Folio.tsx`, change the projection literal `sourceFormat: "example"` to `sourceFormat: "markdown"`, and replace the fallback notice copy with:

```tsx
          The recipe structure could not be read. The original Markdown is
          preserved in the editor below. To restore structured editing, include
          Ingredients, Steps, and Notes once and in that order as headings of
          one consistent level, with bullet ingredients and numbered steps.
          Components may be grouped under headings one level deeper.
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `cd ui && bun run test`
Expected: PASS. `FolioRecipe.test.tsx` needs its `serializeRecipeMarkdown({...})` argument moved to the group shape; the bare-marker `canonicalRecipeMarkdown` input stays as is.

- [ ] **Step 13: Gates and commit**

```bash
cd ui && bun run typecheck && bunx biome lint src/recipe src/components/codex/recipe && bun run test
cd .. && git add ui/src && git commit -m "feat(recipes): Group ingredients and steps by dish component"
```

---

### Task 7: Document the format

**Files:**
- Modify: `ui/src/docs/content/recipes.mdx`

**Interfaces:**
- Consumes: the format as implemented in Tasks 1–6.
- Produces: no code interface. `export const meta` must keep `slug: "recipes"` — `ui/src/docs/mdx-smoke.test.tsx:262` asserts it.

- [ ] **Step 1: Rewrite the format sections**

Keep the `meta` block and the "Create and file a recipe" section. Replace "Recipe format", "Structured editing", and "When Clepsydra falls back to Markdown" so they describe what now ships:

- The canonical body is `## Ingredients`, `## Steps`, `## Notes`, with `-` ingredient bullets and `1.` steps. Show the full example from the spec, groups included.
- `###` headings one level below a section name a component group. Items before the first group belong to the section itself. Ingredients and Steps group independently. Step numbers restart in each group.
- A step may carry indented continuation lines, kept verbatim. Ingredients are single-line.
- Creating a RECIPE page writes the three headings, so a new recipe opens structured and empty.
- Legacy bodies — bare `INGREDIENTS` markers with `•` bullets — are still read, and are rewritten to the canonical form only when you save a structured edit. They cannot carry groups.
- Fallback cases: missing, duplicated, or out-of-order sections; inconsistent heading levels; a group heading at the wrong depth or with no name; a group heading in the legacy format; unsupported list shapes.
- The editor: a textarea per section and per group, one item per line, list markers stripped from anything pasted; step numbers are not shown while editing; Add group and Remove group, where removing a group moves its items to the group above.

Delete every claim that the canonical body uses uppercase markers or `•` bullets — that is the format this change retires.

- [ ] **Step 2: Verify the docs still build and render**

Run: `cd ui && bun run test src/docs && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/docs/content/recipes.mdx && git commit -m "docs(recipes): Document h2 sections, component groups, and textarea editing"
```

---

### Task 8: Normalise the three recipes in the vault

A throwaway script, run once. Nothing here is committed — the vault is not part of this repository.

**Files:**
- Create (not committed): `<scratchpad>/normalise-recipes.ts`

**Interfaces:**
- Consumes: `parseRecipeMarkdown` and `serializeRecipeMarkdown` from Task 6.
- Produces: three rewritten files in `~/Documents/vault/recipes/`.

- [ ] **Step 1: Back the files up first**

```bash
mkdir -p "$SCRATCHPAD/recipe-backup" && cp ~/Documents/vault/recipes/*.md "$SCRATCHPAD/recipe-backup/"
```

Use the session scratchpad path in place of `$SCRATCHPAD`. Do not skip this — the script rewrites files in place.

- [ ] **Step 2: Write the script**

```ts
// Throwaway: normalise every recipe body in the vault to the canonical form.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseRecipeMarkdown,
  serializeRecipeMarkdown,
} from "../ui/src/recipe/recipeCodec";

const dir = join(homedir(), "Documents/vault/recipes");
const apply = process.argv.includes("--write");

for (const name of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
  const source = await readFile(join(dir, name), "utf8");
  const match = source.match(/^\+\+\+\n([\s\S]*?)\n\+\+\+\n([\s\S]*)$/);
  if (!match?.[1] || match[2] === undefined) {
    console.log(`skip  ${name}: no TOML frontmatter`);
    continue;
  }
  const [, frontmatter, body] = match;
  const title = frontmatter.match(/^title\s*=\s*"(.*)"$/m)?.[1] ?? "";

  const parsed = parseRecipeMarkdown(body, title);
  if (!parsed.ok) {
    console.log(`skip  ${name}: ${parsed.reason}`);
    continue;
  }

  const next = `+++\n${frontmatter}\n+++\n${serializeRecipeMarkdown(parsed.value)}`;
  if (next === source) {
    console.log(`same  ${name}`);
    continue;
  }
  if (apply) await writeFile(join(dir, name), next, "utf8");
  console.log(`${apply ? "wrote" : "would"} ${name}`);
}
```

Adjust the relative import to the actual scratchpad location.

- [ ] **Step 3: Dry run, read the output, then apply**

```bash
cd ui && bunx tsx "$SCRATCHPAD/normalise-recipes.ts"
```

Expected: three `would` lines. If any line says `skip`, stop and report the reason rather than applying — a `skip` means the codec cannot read a body it is meant to read, which is a bug in Tasks 1–6, not in the data.

Then:

```bash
cd ui && bunx tsx "$SCRATCHPAD/normalise-recipes.ts" --write
```

- [ ] **Step 4: Verify by eye**

```bash
head -30 ~/Documents/vault/recipes/*.md
```

Confirm: `## Ingredients` / `- ` / `1. ` throughout; the phở file's duplicated title line is gone; `double-black-bean-stew` keeps its multi-line steps with three-space continuation indents.

- [ ] **Step 5: Full verification gates**

```bash
cd ui && bun run typecheck && bun run lint 2>&1 | tail -5 && bun run test
cd .. && cargo test && cargo clippy --all-targets -- -D warnings
```

`bun run lint` reports the pre-existing repo-wide errors. Confirm none of them are in `src/recipe/` or `src/components/codex/recipe/`, and that the count has not grown against `develop`.

- [ ] **Step 6: Merge**

Report all gate output explicitly, then merge the branch into `develop` per the repo's git workflow.
