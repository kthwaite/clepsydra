/**
 * `o` and `O` open a line. Enter on an empty bullet means "leave the list", so
 * they cannot go through it there: an empty item gets a new sibling instead.
 */
import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import type { ListItemElement } from "#/editor/schema/types";
import { li, makeEditor, snapshot, ul } from "./fixtures";
import { keys } from "./helpers";

describe("o on an empty item", () => {
  it("opens a new item below and stays in the list", () => {
    const editor = makeEditor(ul(li("ab"), li("|"), li("z")));
    const state = keys(editor, "o");
    expect(state.mode).toBe("insert");
    expect(snapshot(editor)).toEqual(["li:ab", "li:", "li:|", "li:z"]);
  });

  it("does not outdent an empty nested item", () => {
    const editor = makeEditor(ul(li("ab", ul(li("|"))), li("z")));
    keys(editor, "o");
    expect(snapshot(editor)).toEqual(["li:ab", "li2:", "li2:|", "li:z"]);
  });

  it("opens below an empty item's children", () => {
    const editor = makeEditor(ul(li("|", ul(li("kid"))), li("z")));
    keys(editor, "o");
    expect(snapshot(editor)).toEqual(["li:", "li2:kid", "li:|", "li:z"]);
  });

  it("treats a whitespace-only item as empty, as Enter does", () => {
    const editor = makeEditor(ul(li(" |"), li("z")));
    keys(editor, "o");
    expect(snapshot(editor)).toEqual(["li: ", "li:|", "li:z"]);
  });

  it("opens an unchecked task under an empty task", () => {
    const task = (text: string, checked: boolean) =>
      ({
        type: "list-item",
        checked,
        children: [{ type: "paragraph", children: [{ text }] }],
      }) as ListItemElement;
    const editor = makeEditor(ul(task("|", true)));
    keys(editor, "o");
    const items = (editor.children[0] as { children: Descendant[] }).children;
    expect((items[1] as ListItemElement).checked).toBe(false);
  });
});

describe("O on an empty item", () => {
  it("puts typed text on the new line, never on a neighbour", () => {
    const editor = makeEditor(ul(li("ab"), li("|"), li("z")));
    keys(editor, "O");
    editor.insertText("Q");
    expect(snapshot(editor)).toEqual(["li:ab", "li:Q|", "li:", "li:z"]);
  });

  it("opens above an empty first item", () => {
    const editor = makeEditor(ul(li("|"), li("z")));
    keys(editor, "O");
    expect(snapshot(editor)).toEqual(["li:|", "li:", "li:z"]);
  });

  it("leaves an empty parent's children under it", () => {
    const editor = makeEditor(ul(li("|", ul(li("kid")))));
    keys(editor, "O");
    expect(snapshot(editor)).toEqual(["li:|", "li:", "li2:kid"]);
  });
});

describe("o and O on an item with text", () => {
  it("still go through list continuation", () => {
    const below = makeEditor(ul(li("it|em"), li("z")));
    keys(below, "o");
    expect(snapshot(below)).toEqual(["li:item", "li:|", "li:z"]);
    const above = makeEditor(ul(li("it|em"), li("z")));
    keys(above, "O");
    expect(snapshot(above)).toEqual(["li:|", "li:item", "li:z"]);
  });
});
