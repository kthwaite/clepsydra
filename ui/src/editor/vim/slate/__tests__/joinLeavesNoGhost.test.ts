/**
 * Joining lines across list items moves the end block into the start block.
 * The item it came from must not stay behind as an empty bullet, and whatever
 * else that item held must keep its place in reading order.
 */
import type { Descendant, Editor } from "slate";
import { Element } from "slate";
import { describe, expect, it } from "vitest";
import type { ListItemElement } from "#/editor/schema/types";
import { li, makeEditor, snapshot, t, ul } from "./fixtures";
import { keys } from "./helpers";

const link = { type: "wikilink", target: "Foo", children: [{ text: "" }] };

/** An item whose paragraph holds mixed leaves, then any block children. */
const item = (parts: unknown[], ...rest: Descendant[]) =>
  ({
    type: "list-item",
    children: [
      {
        type: "paragraph",
        children: parts.map((x) => (typeof x === "string" ? { text: x } : x)),
      },
      ...rest,
    ],
  }) as ListItemElement;

/** No item may lead with a nested list or be left without a paragraph. */
function expectCanonicalItems(nodes: Descendant[]) {
  for (const node of nodes) {
    if (!Element.isElement(node)) continue;
    if (node.type === "list-item") {
      const lead = node.children[0] as Element;
      expect(lead.type).toBe("paragraph");
    }
    expectCanonicalItems(node.children as Descendant[]);
  }
}

const bold = (text: string) => t(text, { bold: true });

describe("J onto an item with several leaves", () => {
  it("leaves no bullet behind when the item has bold text", () => {
    const editor = makeEditor(ul(li("|ab"), item(["x", bold("cd")])));
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["li:ab| xcd"]);
  });

  it("leaves no bullet behind when the item has a link", () => {
    const editor = makeEditor(ul(li("|ab"), item(["x", link, "y"])));
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["li:ab| xy"]);
  });

  it("3J leaves no bullet behind", () => {
    const editor = makeEditor(ul(li("|ab"), li("cd"), item(["ef", bold("g")])));
    keys(editor, "3J");
    expect(snapshot(editor)).toEqual(["li:ab cd| efg"]);
  });

  it("removes a nested list left empty", () => {
    const editor = makeEditor(
      ul(li("|ab", ul(item(["x", bold("cd")]))), li("z")),
    );
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["li:ab| xcd", "li:z"]);
    expectCanonicalItems(editor.children);
  });
});

describe("a charwise delete ending before an item's last leaf", () => {
  it("v leaves no bullet behind", () => {
    const editor = makeEditor(ul(li("a|bc"), item(["ia", bold("cd")])));
    keys(editor, "vjd");
    expect(snapshot(editor)).toEqual(["li:a|cd"]);
  });
});

describe("joining away an item that has children", () => {
  it("J gives its children to the line it joined", () => {
    const editor = makeEditor(ul(li("|ab"), li("cd", ul(li("kid")))));
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["li:ab| cd", "li2:kid"]);
    expectCanonicalItems(editor.children);
  });

  it("J onto a first child keeps its children above its siblings", () => {
    const editor = makeEditor(ul(li("|a", ul(li("b", ul(li("c"))), li("d")))));
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["li:a| b", "li2:c", "li2:d"]);
    expectCanonicalItems(editor.children);
  });

  it("2cc gives the children to the cleared line", () => {
    const editor = makeEditor(ul(li("|ab"), li("cd", ul(li("kid")))));
    keys(editor, "2cc");
    expect(snapshot(editor)).toEqual(["li:|", "li2:kid"]);
    expectCanonicalItems(editor.children);
  });

  it("v across items gives the children to the surviving line", () => {
    const editor = makeEditor(ul(li("ab|c"), li("de", ul(li("kid")))));
    keys(editor, "vjd");
    expect(snapshot(editor).map((s) => s.replace("|", ""))).toEqual([
      "li:ab",
      "li2:kid",
    ]);
    expectCanonicalItems(editor.children);
  });
});

describe("a span covering a whole item in the middle", () => {
  it("3cc gives that item's other children to the cleared line", () => {
    const editor = makeEditor(
      ul(li("|a"), li("b", ul(li("c"), li("d"))), li("z")),
    );
    keys(editor, "3cc");
    expect(snapshot(editor)).toEqual(["li:|", "li2:d", "li:z"]);
    expectCanonicalItems(editor.children);
  });
});

describe("undo", () => {
  const start = (editor: Editor) => JSON.stringify(editor.children);

  it("restores a J that removed a ghost", () => {
    const editor = makeEditor(ul(li("|ab"), item(["x", bold("cd")])));
    const before = start(editor);
    const state = keys(editor, "J");
    keys(editor, "u", state);
    expect(start(editor)).toBe(before);
  });

  it("restores a J that moved children", () => {
    const editor = makeEditor(ul(li("|ab"), li("cd", ul(li("kid"))), li("z")));
    const before = start(editor);
    const state = keys(editor, "J");
    keys(editor, "u", state);
    expect(start(editor)).toBe(before);
  });
});
