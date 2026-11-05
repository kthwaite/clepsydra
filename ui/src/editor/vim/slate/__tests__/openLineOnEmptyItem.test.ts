/**
 * `o` and `O` open a line. Enter on an empty bullet means "leave the list", so
 * they cannot go through it there: an empty item gets a new sibling instead.
 */
import type { Descendant, Editor } from "slate";
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

describe("O on an item with text", () => {
  const task = (text: string, checked: boolean) =>
    ({
      type: "list-item",
      checked,
      children: [{ type: "paragraph", children: [{ text }] }],
    }) as ListItemElement;
  const checks = (editor: Editor) =>
    (editor.children[0] as { children: ListItemElement[] }).children.map(
      (item) => item.checked,
    );

  it("leaves a checked task's check on its own line", () => {
    const editor = makeEditor(ul(task("a|b", true)));
    keys(editor, "O");
    expect(snapshot(editor)).toEqual(["li:|", "li:ab"]);
    expect(checks(editor)).toEqual([false, true]);
  });

  it("opens an unchecked task above an unchecked task", () => {
    const editor = makeEditor(ul(task("a|b", false)));
    keys(editor, "O");
    expect(checks(editor)).toEqual([false, false]);
  });

  it("opens a plain item above a plain item", () => {
    const editor = makeEditor(ul(li("a|b")));
    keys(editor, "O");
    expect(checks(editor)).toEqual([undefined, undefined]);
  });

  it("leaves a parent's text above its children", () => {
    const editor = makeEditor(ul(li("a|b", ul(li("kid")))));
    keys(editor, "O");
    expect(snapshot(editor)).toEqual(["li:|", "li:ab", "li2:kid"]);
  });

  it("types on the new line", () => {
    const editor = makeEditor(ul(task("a|b", true), task("z", false)));
    keys(editor, "O");
    editor.insertText("Q");
    expect(snapshot(editor)).toEqual(["li:Q|", "li:ab", "li:z"]);
    expect(checks(editor)).toEqual([false, true, false]);
  });

  it("undoes in one step", () => {
    const editor = makeEditor(ul(task("a|b", true)));
    const before = JSON.stringify(editor.children);
    const state = keys(editor, "O");
    keys(editor, "<Esc>u", state);
    expect(JSON.stringify(editor.children)).toBe(before);
  });
});

describe("o and O on an item with text", () => {
  it("still open a line next to it", () => {
    const below = makeEditor(ul(li("it|em"), li("z")));
    keys(below, "o");
    expect(snapshot(below)).toEqual(["li:item", "li:|", "li:z"]);
    const above = makeEditor(ul(li("it|em"), li("z")));
    keys(above, "O");
    expect(snapshot(above)).toEqual(["li:|", "li:item", "li:z"]);
  });
});
