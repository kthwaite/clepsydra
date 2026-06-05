import { describe, expect, it } from "vitest";
import { slashCommandToConversion } from "../SlateEditor";

describe("slashCommandToConversion", () => {
  it("SC-01: maps h1..h6 to heading levels", () => {
    expect(slashCommandToConversion("h1")).toEqual({
      type: "heading",
      level: 1,
    });
    expect(slashCommandToConversion("h6")).toEqual({
      type: "heading",
      level: 6,
    });
  });

  it("SC-02: maps list commands", () => {
    expect(slashCommandToConversion("bullet")).toEqual({
      type: "bulleted-list",
    });
    expect(slashCommandToConversion("number")).toEqual({
      type: "numbered-list",
    });
    expect(slashCommandToConversion("task")).toEqual({ type: "task" });
  });

  it("SC-03: maps quote, code, divider", () => {
    expect(slashCommandToConversion("quote")).toEqual({ type: "blockquote" });
    expect(slashCommandToConversion("code")).toEqual({ type: "code-block" });
    expect(slashCommandToConversion("divider")).toEqual({
      type: "thematic-break",
    });
  });

  it("SC-04: returns null for an unknown id", () => {
    expect(slashCommandToConversion("nope")).toBeNull();
  });
});
