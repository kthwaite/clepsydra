/**
 * Vim columns count text only, so a wikilink sits between two columns. A
 * command must treat it as part of neither char it stands between.
 */
import type { Descendant, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import type { ListItemElement } from "#/editor/schema/types";
import { makeEditor, p, ul } from "./fixtures";
import { keys } from "./helpers";

const link = { type: "wikilink", target: "Foo", children: [{ text: "" }] };

const para = (...parts: unknown[]) => {
  const node = p() as { children: unknown[] };
  node.children = parts.map((x) => (typeof x === "string" ? { text: x } : x));
  return node as Descendant;
};

const item = (...parts: unknown[]) =>
  ({ type: "list-item", children: [para(...parts)] }) as ListItemElement;

const md = (editor: Editor) => slateToMarkdown(editor.children);
const firstLine = (editor: Editor) => md(editor).split("\n")[0];

describe("x, r and ~ on the char after a wikilink", () => {
  const doc = () => makeEditor(ul(item("ab", link, "|cd")));

  it("x deletes that char only", () => {
    const editor = doc();
    keys(editor, "x");
    expect(md(editor)).toBe("* ab[[Foo]]d\n");
  });

  it("r replaces that char only", () => {
    const editor = doc();
    keys(editor, "rZ");
    expect(md(editor)).toBe("* ab[[Foo]]Zd\n");
  });

  it("~ toggles that char only", () => {
    const editor = doc();
    keys(editor, "~");
    expect(md(editor)).toBe("* ab[[Foo]]Cd\n");
  });

  it("d$ keeps the link", () => {
    const editor = doc();
    keys(editor, "d$");
    expect(md(editor)).toBe("* ab[[Foo]]\n");
  });

  it("2rZ and 3~ across a link keep it", () => {
    const r = makeEditor(ul(item("a|b", link, "cd")));
    keys(r, "2rZ");
    expect(md(r)).toBe("* aZ[[Foo]]Zd\n");
    const t = makeEditor(ul(item("a|b", link, "cd")));
    keys(t, "3~");
    expect(md(t)).toBe("* aB[[Foo]]CD\n");
  });

  it("x on the char before a link keeps the link", () => {
    const editor = makeEditor(ul(item("a|b", link, "cd")));
    keys(editor, "x");
    expect(md(editor)).toBe("* a[[Foo]]cd\n");
  });
});

describe("r and ~ at the start of a marked run", () => {
  const bold = { text: "|cd", bold: true };

  it("~ keeps the run bold", () => {
    const editor = makeEditor(ul(item("ab", bold)));
    keys(editor, "~");
    expect(md(editor)).toBe("* ab**Cd**\n");
  });

  it("r keeps the run bold", () => {
    const editor = makeEditor(ul(item("ab", bold)));
    keys(editor, "rZ");
    expect(md(editor)).toBe("* ab**Zd**\n");
  });

  it("r keeps a one-char run bold", () => {
    const editor = makeEditor(ul(item("ab", { text: "|c", bold: true })));
    keys(editor, "rZ");
    expect(md(editor)).toBe("* ab**Z**\n");
  });
});

describe("J next to a wikilink", () => {
  it("keeps a link at the end of the current line", () => {
    const editor = makeEditor(ul(item("|ab", link, ""), item("cd")));
    keys(editor, "J");
    expect(md(editor)).toBe("* ab[[Foo]] cd\n");
  });

  it("keeps a link at the start of the next line", () => {
    const editor = makeEditor(ul(item("|ab"), item("", link, "cd")));
    keys(editor, "J");
    expect(firstLine(editor)).toBe("* ab [[Foo]]cd");
  });

  it("keeps a leading link with a space after it", () => {
    const editor = makeEditor(ul(item("|ab"), item("", link, " cd")));
    keys(editor, "J");
    expect(firstLine(editor)).toBe("* ab [[Foo]] cd");
  });

  it("adds a space after a link that follows a space", () => {
    const editor = makeEditor(ul(item("|ab ", link, ""), item("cd")));
    keys(editor, "J");
    expect(firstLine(editor)).toBe("* ab [[Foo]] cd");
  });

  it("still strips a real indent before a link", () => {
    const editor = makeEditor(ul(item("|ab"), item("  ", link, "cd")));
    keys(editor, "J");
    expect(firstLine(editor)).toBe("* ab [[Foo]]cd");
  });

  it("keeps a next line holding only a link", () => {
    const editor = makeEditor(ul(item("|ab"), item("", link, "")));
    keys(editor, "J");
    expect(firstLine(editor)).toBe("* ab [[Foo]]");
  });
});

describe("cc with a wikilink on the line", () => {
  it("clears a link at the end of the line", () => {
    const editor = makeEditor(ul(item("|ab", link, ""), item("cd")));
    keys(editor, "cc");
    expect(md(editor)).toBe("*\n* cd\n");
  });

  it("clears a link at the start of the line", () => {
    const editor = makeEditor(ul(item("", link, "|ab"), item("cd")));
    keys(editor, "cc");
    expect(md(editor)).toBe("*\n* cd\n");
  });

  it("clears a line holding only a link", () => {
    const editor = makeEditor(ul(item("|", link, ""), item("cd")));
    keys(editor, "cc");
    expect(md(editor)).toBe("*\n* cd\n");
  });
});

describe("insert entry next to a wikilink", () => {
  const typed = (editor: Editor, text: string) => editor.insertText(text);

  it("A appends after a link at the end of the line", () => {
    const editor = makeEditor(ul(item("|ab", link, "")));
    keys(editor, "A");
    typed(editor, "Q");
    expect(md(editor)).toBe("* ab[[Foo]]Q\n");
  });

  it("i inserts right before the char after a link", () => {
    const editor = makeEditor(ul(item("ab", link, "|cd")));
    keys(editor, "i");
    typed(editor, "Q");
    expect(md(editor)).toBe("* ab[[Foo]]Qcd\n");
  });

  it("a inserts right after the char before a link", () => {
    const editor = makeEditor(ul(item("a|b", link, "cd")));
    keys(editor, "a");
    typed(editor, "Q");
    expect(md(editor)).toBe("* abQ[[Foo]]cd\n");
  });

  it("I inserts right before the first char after a leading link", () => {
    const editor = makeEditor(ul(item("", link, "|cd")));
    keys(editor, "I");
    typed(editor, "Q");
    expect(md(editor)).toBe("* [[Foo]]Qcd\n");
  });

  it("cw types where the changed word was", () => {
    const editor = makeEditor(ul(item("ab", link, "|cd")));
    keys(editor, "cw");
    typed(editor, "Q");
    expect(md(editor)).toBe("* ab[[Foo]]Q\n");
  });

  it("P pastes right before the char after a link", () => {
    const editor = makeEditor(ul(item("ab", link, "|cd")));
    const state = keys(editor, "yl");
    keys(editor, "P", state);
    expect(md(editor)).toBe("* ab[[Foo]]ccd\n");
  });
});
