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
