import { createEditor, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";

describe("footnote document rules", () => {
  it("renames a duplicate footnote-def identifier to keep ids unique", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "footnote-def", identifier: "1", children: [{ text: "a" }] },
      { type: "footnote-def", identifier: "1", children: [{ text: "b" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const ids = editor.children.map((n) => (n as { identifier: string }).identifier);
    expect(new Set(ids).size).toBe(2);
  });

  it("leaves already-unique footnote-def identifiers untouched", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "footnote-def", identifier: "1", children: [{ text: "a" }] },
      { type: "footnote-def", identifier: "2", children: [{ text: "b" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const ids = editor.children.map((n) => (n as { identifier: string }).identifier);
    expect(ids).toEqual(["1", "2"]);
  });
});
