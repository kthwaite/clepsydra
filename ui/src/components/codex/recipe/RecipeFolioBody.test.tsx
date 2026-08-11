import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  serializeRecipeMarkdown,
  type RecipeDocument,
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
    expect(within(steps).getByText("Toss with lemon and parmesan.")).toBeVisible();

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

  it("adds, focuses, reorders, and removes ingredients with keyboard-accessible controls", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const secondMoveUp = screen.getByRole("button", {
      name: "Move ingredient 2 up",
    });
    secondMoveUp.focus();
    await user.keyboard("{Enter}");
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      ...recipe,
      ingredients: ["1 lemon", "200 g spaghetti", "30 g parmesan"],
    });

    const firstMoveDown = screen.getByRole("button", {
      name: "Move ingredient 1 down",
    });
    firstMoveDown.focus();
    await user.keyboard(" ");
    expect(onDocumentChange).toHaveBeenLastCalledWith(recipe);

    const removeThird = screen.getByRole("button", {
      name: "Remove ingredient 3",
    });
    removeThird.focus();
    await user.keyboard("{Enter}");
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      ...recipe,
      ingredients: ["200 g spaghetti", "1 lemon"],
    });

    const add = screen.getByRole("button", { name: "Add ingredient" });
    add.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Ingredient 3" })).toHaveFocus();
  });

  it("adds, focuses, reorders, and removes steps with keyboard-accessible controls", async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(<ControlledRecipe onDocumentChange={onDocumentChange} />);

    const secondMoveUp = screen.getByRole("button", {
      name: "Move step 2 up",
    });
    secondMoveUp.focus();
    await user.keyboard("{Enter}");
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      ...recipe,
      steps: ["Toss with lemon and parmesan.", "Boil the pasta."],
    });

    const firstMoveDown = screen.getByRole("button", {
      name: "Move step 1 down",
    });
    firstMoveDown.focus();
    await user.keyboard(" ");
    expect(onDocumentChange).toHaveBeenLastCalledWith(recipe);

    const removeSecond = screen.getByRole("button", {
      name: "Remove step 2",
    });
    removeSecond.focus();
    await user.keyboard("{Enter}");
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      ...recipe,
      steps: ["Boil the pasta."],
    });

    const add = screen.getByRole("button", { name: "Add step" });
    add.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Step 2" })).toHaveFocus();
  });

  it("keeps the same ingredient move-up action focused across consecutive moves", async () => {
    const user = userEvent.setup();
    render(<ControlledRecipe />);

    act(() => {
      screen
        .getByRole("button", { name: "Move ingredient 3 up" })
        .focus();
    });
    await user.keyboard("{Enter}");

    const movedAction = screen.getByRole("button", {
      name: "Move ingredient 2 up",
    });
    expect(movedAction).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("textbox", { name: "Ingredient 1" })).toHaveValue(
      "30 g parmesan",
    );
    expect(screen.getByRole("textbox", { name: "Ingredient 2" })).toHaveValue(
      "200 g spaghetti",
    );
    expect(
      screen.getByRole("button", { name: "Move ingredient 1 down" }),
    ).toHaveFocus();
  });

  it("keeps the same step move-down action focused across consecutive moves", async () => {
    const user = userEvent.setup();
    render(
      <ControlledRecipe
        initial={{
          ...recipe,
          steps: ["Boil.", "Toss.", "Serve."],
        }}
      />,
    );

    act(() => {
      screen.getByRole("button", { name: "Move step 1 down" }).focus();
    });
    await user.keyboard("{Enter}");

    const movedAction = screen.getByRole("button", {
      name: "Move step 2 down",
    });
    expect(movedAction).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("textbox", { name: "Step 3" })).toHaveValue(
      "Boil.",
    );
    expect(screen.getByRole("textbox", { name: "Step 2" })).toHaveValue(
      "Serve.",
    );
    expect(
      screen.getByRole("button", { name: "Move step 3 up" }),
    ).toHaveFocus();
  });

  it("does not persist newly added empty rows in canonical Markdown", async () => {
    const user = userEvent.setup();
    const serialized = vi.fn<(markdown: string) => void>();
    render(
      <ControlledRecipe
        onDocumentChange={(next) => serialized(serializeRecipeMarkdown(next))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add ingredient" }));
    expect(serialized).toHaveBeenLastCalledWith(
      "A bright, weeknight pasta.\n\nINGREDIENTS\n• 200 g spaghetti\n• 1 lemon\n• 30 g parmesan\n\nSTEPS\n1. Boil the pasta.\n2. Toss with lemon and parmesan.\n\nNOTES\nServe with **black pepper** and [[salad]].\n",
    );
  });
});
