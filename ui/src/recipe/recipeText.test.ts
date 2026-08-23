import { describe, expect, it } from "vitest";
import {
  itemsFromText,
  stepsFromText,
  textFromItems,
  textFromSteps,
} from "#/recipe/recipeText";

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

describe("stepsFromText", () => {
  it("starts a step at each unindented line", () => {
    expect(stepsFromText("Boil the pasta.\nDrain.")).toEqual([
      "Boil the pasta.",
      "Drain.",
    ]);
  });

  it("folds indented lines into the step above", () => {
    expect(
      stepsFromText(
        "Start the aromatics\n  Heat the oil.\n  Add shallots.\nServe.",
      ),
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
