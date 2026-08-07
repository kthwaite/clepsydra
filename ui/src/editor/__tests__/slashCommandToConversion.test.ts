import { describe, expect, it } from "vitest";
import * as SlateEditorModule from "../SlateEditor";

const { slashCommandToConversion } = SlateEditorModule;

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

  it("SC-04: discovers Time Heading in the slash menu", () => {
    const commands = (
      SlateEditorModule as unknown as {
        SLASH_COMMANDS: Array<{ id: string; label: string }>;
      }
    ).SLASH_COMMANDS;
    expect(commands).toContainEqual(
      expect.objectContaining({ id: "time", label: "Time Heading" }),
    );
  });

  it("SC-05: dispatches the time command to journal-time insertion", () => {
    expect(slashCommandToConversion("time")).toEqual({
      type: "journal-time",
    });
  });

  it("SC-06: returns null for an unknown id", () => {
    expect(slashCommandToConversion("nope")).toBeNull();
  });
});
