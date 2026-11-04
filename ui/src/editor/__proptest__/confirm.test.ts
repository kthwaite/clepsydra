/**
 * Deterministic reproductions of each candidate finding, written as the
 * behaviour a user should see. Every test here failed on unmodified dev.
 */
import { type Descendant, Editor, Node, Transforms } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../convert";
import { makeEditor, outline, tick } from "./harness";
import { indentListItem, outdentListItem } from "../plugins/withOutliner";
import { HistoryEditor } from "slate-history";

const p = (text: string): Descendant => ({ type: "paragraph", children: [{ text }] }) as Descendant;
const li = (text: string, ...rest: Descendant[]): Descendant =>
  ({ type: "list-item", children: [p(text), ...rest] }) as Descendant;
const ul = (...items: Descendant[]): Descendant =>
  ({ type: "bulleted-list", children: items }) as Descendant;
const wikilink = (target: string): Descendant =>
  ({ type: "wikilink", target, children: [{ text: "" }] }) as unknown as Descendant;

/** `text` per line with depth and kind, in reading order. */
const view = (e: Editor) => outline(e).map((l) => `${l.depth}${l.kind}:${l.text}`);
const fromMd = (md: string) => makeEditor(markdownToSlate(md));
const toMd = (e: Editor) => slateToMarkdown(e.children);
const lineText = (e: Editor) =>
  outline(e).map((l) => l.text);

function caretOn(e: Editor, text: string, offset = 0) {
  const line = outline(e).find((l) => l.text === text);
  if (!line) throw new Error(`no line ${text}`);
  Transforms.select(e, Editor.start(e, line.path));
  if (offset) Transforms.move(e, { distance: offset, unit: "offset" });
}

describe("Enter", () => {
  it("C1: on an item holding only a wikilink adds a bullet and keeps the link", () => {
    const e = makeEditor([
      ul({
        type: "list-item",
        children: [
          { type: "paragraph", children: [{ text: "" }, wikilink("Foo"), { text: "" }] },
        ],
      } as Descendant),
    ]);
    Transforms.select(e, Editor.end(e, [0, 0, 0]));
    Editor.insertBreak(e);
    expect(toMd(e)).toContain("[[Foo]]");
  });

  it("C1b: the same void-only case inside a blockquote keeps the link", () => {
    const e = makeEditor([
      {
        type: "blockquote",
        children: [
          { type: "paragraph", children: [{ text: "" }, wikilink("Foo"), { text: "" }] },
        ],
      } as Descendant,
    ]);
    Transforms.select(e, Editor.end(e, [0, 0]));
    Editor.insertBreak(e);
    expect(toMd(e)).toContain("[[Foo]]");
  });

  it("C2: on an empty parent keeps its children", () => {
    const e = makeEditor([ul(li("", ul(li("kid"))))]);
    Transforms.select(e, Editor.start(e, [0, 0, 0]));
    Editor.insertBreak(e);
    expect(lineText(e)).toContain("kid");
  });

  it("C2b: on an empty mid-list item keeps document order", () => {
    const e = makeEditor([ul(li("above"), li(""), li("below"))]);
    Transforms.select(e, Editor.start(e, [0, 1, 0]));
    Editor.insertBreak(e);
    expect(view(e)).toEqual(["1b:above", "0p:", "1b:below"]);
    expect(e.selection?.anchor.path).toEqual(Editor.start(e, outline(e)[1].path).path);
  });

  it("C8: at the start of a parent leaves its text above its children", () => {
    const e = makeEditor([ul(li("parent", ul(li("kid"))))]);
    caretOn(e, "parent");
    Editor.insertBreak(e);
    expect(lineText(e).filter(Boolean)).toEqual(["parent", "kid"]);
  });

  it("C8b: mid-text in a parent keeps reading order", () => {
    const e = makeEditor([ul(li("head tail", ul(li("kid"))))]);
    caretOn(e, "head tail", 5);
    Editor.insertBreak(e);
    expect(lineText(e)).toEqual(["head ", "tail", "kid"]);
  });

  it("C10: over a selection inside a bullet makes a new bullet", () => {
    const e = makeEditor([ul(li("abcd"))]);
    Transforms.select(e, {
      anchor: { path: [0, 0, 0, 0], offset: 1 },
      focus: { path: [0, 0, 0, 0], offset: 3 },
    });
    Editor.insertBreak(e);
    expect(view(e)).toEqual(["1b:a", "1b:d"]);
  });
});

describe("Backspace", () => {
  it("C3: at the start of an item keeps its second paragraph", () => {
    const e = fromMd("- first\n\n  second\n");
    caretOn(e, "first");
    Editor.deleteBackward(e, { unit: "character" });
    expect(lineText(e)).toEqual(["first", "second"]);
  });

  it("C3b: at the start of an item keeps its code block", () => {
    const e = fromMd("- first\n\n  ```\n  code\n  ```\n");
    caretOn(e, "first");
    Editor.deleteBackward(e, { unit: "character" });
    expect(lineText(e)).toEqual(["first", "code"]);
  });

  it("C3c: at the start of an item keeps its block id", () => {
    const e = fromMd("- first ^abcdefghij\n");
    caretOn(e, "first");
    Editor.deleteBackward(e, { unit: "character" });
    expect(toMd(e)).toContain("^abcdefghij");
  });
});

describe("Tab history", () => {
  it("C9: two outdents keep reading order", () => {
    const e = fromMd("- g\n  - x\n    - k\n  - y\n");
    caretOn(e, "x");
    outdentListItem(e);
    caretOn(e, "k");
    outdentListItem(e);
    expect(lineText(e)).toEqual(["g", "x", "k", "y"]);
  });
});

describe("Merging a bullet with children", () => {
  it("C7: Delete at the end of the previous item keeps a canonical shape", () => {
    const e = fromMd("- a\n- b\n  - kid\n");
    caretOn(e, "a", 1);
    Editor.deleteForward(e, { unit: "character" });
    const items = (e.children[0] as { children: { children: { type: string }[] }[] }).children;
    for (const item of items) expect(item.children[0].type).toBe("paragraph");
    expect(lineText(e).join("")).toBe("abkid");
  });
});

describe("Save and reload", () => {
  const roundTrip = (e: Editor) => makeEditor(markdownToSlate(toMd(e)));

  it("C4: an empty task with children serializes as parseable Markdown", () => {
    const e = makeEditor([
      ul({ type: "list-item", checked: false, children: [p(""), ul(li("kid"))] } as Descendant),
    ]);
    const md = toMd(e);
    expect(md).not.toMatch(/^\[ \]/m);
    const back = roundTrip(e);
    expect(lineText(back)).toEqual(["", "kid"]);
    expect(outline(back)[0].checked).toBe(false);
  });

  it("C5: an empty lead paragraph does not push the item's text out of the list", () => {
    const e = makeEditor([
      ul({ type: "list-item", children: [p(""), p("text")] } as Descendant, li("next")),
    ]);
    const back = roundTrip(e);
    expect(view(back).filter((l) => !l.endsWith(":"))).toEqual(
      expect.arrayContaining(["1b:next"]),
    );
    expect(back.children).toHaveLength(1);
  });

  it("C6: an empty parent with children keeps its own line", () => {
    const e = makeEditor([ul(li("", ul(li("kid"))))]);
    const back = roundTrip(e);
    expect(view(back)).toEqual(["1b:", "2b:kid"]);
    expect(Node.string(back)).toBe("kid");
  });
});

describe("Undo after each repro (control: history holds)", () => {
  it("restores Enter on an empty parent", async () => {
    const e = makeEditor([ul(li("", ul(li("kid"))))]);
    const start = JSON.stringify(e.children);
    Transforms.select(e, Editor.start(e, [0, 0, 0]));
    await tick();
    Editor.insertBreak(e);
    await tick();
    HistoryEditor.undo(e as HistoryEditor);
    expect(JSON.stringify(e.children)).toBe(start);
  });
});

void indentListItem;
