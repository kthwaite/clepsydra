import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type RecipeDocument,
  serializeRecipeMarkdown,
} from "#/recipe/recipeCodec";
import { RecipeFolioBody } from "./RecipeFolioBody";

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

const recipe: RecipeDocument = {
  description: "A bright, weeknight pasta.",
  ingredients: ["200 g spaghetti", "1 lemon", "30 g parmesan"],
  steps: ["Boil the pasta.", "Toss with lemon and parmesan."],
  notesMarkdown: "Serve with **black pepper** and [[salad]].",
};

function ControlledRecipe({
  initial = recipe,
  mode: initialMode = "edit",
  onDocumentChange = vi.fn(),
}: {
  initial?: RecipeDocument;
  mode?: "read" | "edit";
  onDocumentChange?: (document: RecipeDocument) => void;
}) {
  const [document, setDocument] = useState(initial);
  const [mode, setMode] = useState(initialMode);
  return (
    <RecipeFolioBody
      document={document}
      mode={mode}
      onModeChange={setMode}
      onDocumentChange={(next) => {
        setDocument(next);
        onDocumentChange(next);
      }}
    />
  );
}

describe("RecipeFolioBody", () => {
  it("presents a semantic recipe without completion checkboxes", () => {
    render(
      <RecipeFolioBody
        document={recipe}
        mode="read"
        onModeChange={vi.fn()}
        onDocumentChange={vi.fn()}
      />,
    );

    expect(screen.getByText("A bright, weeknight pasta.")).toBeVisible();

    const ingredients = screen.getByRole("region", { name: "Ingredients" });
    expect(within(ingredients).getAllByRole("listitem")).toHaveLength(3);
    expect(within(ingredients).getByText("1 lemon")).toBeVisible();
    expect(within(ingredients).queryByRole("checkbox")).toBeNull();

    const steps = screen.getByRole("region", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(steps).getByText("Toss with lemon and parmesan."),
    ).toBeVisible();

    const notes = screen.getByRole("region", { name: "Notes" });
    expect(within(notes).getByText("black pepper").tagName).toBe("STRONG");
    expect(within(notes).getByText("salad")).toBeVisible();
  });

  it("uses a labelled segmented radio control for Read and Edit", async () => {
    const user = userEvent.setup();
    render(<ControlledRecipe mode="read" />);

    const modes = screen.getByRole("radiogroup", { name: "Recipe mode" });
    const read = within(modes).getByRole("radio", { name: "Read" });
    const edit = within(modes).getByRole("radio", { name: "Edit" });
    expect(read).toBeChecked();

    read.focus();
    await user.keyboard("{ArrowRight}");

    expect(edit).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Description" })).toBeVisible();
  });

  it("reports controlled description and notes edits", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const description = screen.getByRole("textbox", { name: "Description" });
    await user.clear(description);
    await user.type(description, "Silky lemon pasta.");
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      ...recipe,
      description: "Silky lemon pasta.",
    });

    const notes = screen.getByRole("textbox", { name: "Notes" });
    await user.clear(notes);
    await user.type(notes, "Finish with **pepper**.");
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      ...recipe,
      description: "Silky lemon pasta.",
      notesMarkdown: "Finish with **pepper**.",
    });
  });

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
});
