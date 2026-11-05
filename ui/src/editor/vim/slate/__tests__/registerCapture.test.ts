/**
 * A linewise register holds what the lines hold: each captured once, whole, with
 * marks and links, and pasted into a code block one line per line.
 */
import type { Descendant, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import type { ListItemElement } from "#/editor/schema/types";
import { code, li, makeEditor, snapshot, ul } from "./fixtures";
import { keys } from "./helpers";

const link = { type: "wikilink", target: "Foo", children: [{ text: "" }] };

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

const md = (editor: Editor) => slateToMarkdown(editor.children);

describe("a count ending inside a block of an item already captured", () => {
  const doc = () => makeEditor(ul(li("|ab", code("c1\nc2\nc3")), li("z")));

  it("holds the item once", () => {
    const state = keys(doc(), "2yy");
    expect(state.register?.fragment).toHaveLength(1);
  });

  it("2dd then P restores the document", () => {
    const editor = doc();
    const before = md(editor);
    keys(editor, "2ddP");
    expect(md(editor)).toBe(before);
  });

  it("still captures a partial code block on its own", () => {
    const editor = makeEditor(code("a|a\nbb\ncc"));
    const state = keys(editor, "yy");
    expect(state.register?.fragment).toEqual([
      { type: "code-block", children: [{ text: "aa" }] },
    ]);
  });
});

describe("linewise paste into a code block", () => {
  it("keeps a parent and its child on separate lines", () => {
    const editor = makeEditor(ul(li("pa|r", ul(li("kid")))), code("aa\nbb"));
    const state = keys(editor, "yy");
    keys(editor, "jjjp", state);
    expect(snapshot(editor)).toEqual([
      "li:par",
      "li2:kid",
      "code:aa\nbb\n|par\nkid",
      "",
    ]);
  });

  it("keeps an item's second paragraph on its own line", () => {
    const para = { type: "paragraph", children: [{ text: "two" }] };
    const editor = makeEditor(
      ul(item(["on|e"], para as Descendant)),
      code("aa"),
    );
    const state = keys(editor, "yy");
    keys(editor, "jjp", state);
    expect(snapshot(editor)[2]).toBe("code:aa\n|one\ntwo");
  });

  it("keeps a code block's own lines", () => {
    const editor = makeEditor(ul(li("x", code("c|1\nc2"))), code("aa"));
    const state = keys(editor, "2yy");
    keys(editor, "jjp", state);
    expect(snapshot(editor)[2]).toBe("code:aa\n|c1\nc2");
  });
});

describe("one line of a hard-broken paragraph", () => {
  it("yy then p keeps bold text", () => {
    const editor = makeEditor(
      ul(item([{ text: "|ab", bold: true }, "\ncd"]), li("z")),
    );
    const state = keys(editor, "yy");
    keys(editor, "jjp", state);
    expect(md(editor).match(/\*\*ab\*\*/g)).toHaveLength(2);
  });

  it("yy on the second line keeps its marks too", () => {
    const editor = makeEditor(
      ul(item(["ab\n", { text: "c|d", bold: true }]), li("z")),
    );
    const state = keys(editor, "yy");
    keys(editor, "jp", state);
    expect(md(editor)).toContain("* **cd**\n");
  });

  it("dd then p keeps a link ending the line", () => {
    const editor = makeEditor(ul(item(["|ab", link, "\ncd"]), li("z")));
    keys(editor, "ddp");
    expect(md(editor)).toContain("[[Foo]]");
  });

  it("the deleted line and the register agree", () => {
    const editor = makeEditor(ul(item(["|ab", link, "\ncd"]), li("z")));
    const state = keys(editor, "dd");
    expect(md(editor)).toBe("* cd\n* z\n");
    expect(state.register?.fragment).toHaveLength(1);
    const [held] = state.register?.fragment ?? [];
    expect(slateToMarkdown([held])).toBe("ab[[Foo]]\n");
  });

  it("keeps the second line's break out of the register", () => {
    const editor = makeEditor(ul(item(["|ab\ncd"]), li("z")));
    const state = keys(editor, "yy");
    const [held] = state.register?.fragment ?? [];
    expect(slateToMarkdown([held])).toBe("ab\n");
  });
});
