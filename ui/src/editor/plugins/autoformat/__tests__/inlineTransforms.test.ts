import { createEditor, type Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withSchema } from "../../../schema/withSchema";
import { tryInlineTransform } from "../inlineTransforms";

function editorWith(text: string, offset: number) {
  const editor = withSchema(withHistory(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset },
    focus: { path: [0, 0], offset },
  });
  return editor;
}

function getLeaves(editor: Editor): any[] {
  const para = editor.children[0] as any;
  return para.children;
}

describe("tryInlineTransform", () => {
  it("IT-01: *a* → italic", () => {
    const editor = editorWith("*a", 2);
    const result = tryInlineTransform(editor, "*");
    expect(result).toBe(true);
    const leaves = getLeaves(editor);
    expect(leaves.some((l: any) => l.italic === true && l.text === "a")).toBe(
      true,
    );
  });

  it("IT-02: **a** → bold", () => {
    const editor = editorWith("**a*", 4);
    const result = tryInlineTransform(editor, "*");
    expect(result).toBe(true);
    const leaves = getLeaves(editor);
    expect(leaves.some((l: any) => l.bold === true && l.text === "a")).toBe(
      true,
    );
  });

  it("IT-03: _a_ → italic", () => {
    const editor = editorWith("_a", 2);
    const result = tryInlineTransform(editor, "_");
    expect(result).toBe(true);
    const leaves = getLeaves(editor);
    expect(leaves.some((l: any) => l.italic === true && l.text === "a")).toBe(
      true,
    );
  });

  it("IT-03: __a__ → bold", () => {
    const editor = editorWith("__a_", 4);
    const result = tryInlineTransform(editor, "_");
    expect(result).toBe(true);
    const leaves = getLeaves(editor);
    expect(leaves.some((l: any) => l.bold === true && l.text === "a")).toBe(
      true,
    );
  });

  it("IT-04: ~a~ → strikethrough", () => {
    const editor = editorWith("~a", 2);
    const result = tryInlineTransform(editor, "~");
    expect(result).toBe(true);
    const leaves = getLeaves(editor);
    expect(
      leaves.some((l: any) => l.strikethrough === true && l.text === "a"),
    ).toBe(true);
  });

  it("IT-05: backtick a backtick → code", () => {
    const editor = editorWith("`a", 2);
    const result = tryInlineTransform(editor, "`");
    expect(result).toBe(true);
    const leaves = getLeaves(editor);
    expect(leaves.some((l: any) => l.code === true && l.text === "a")).toBe(
      true,
    );
  });

  it("IT-06: [text](url) → link element", () => {
    const editor = editorWith("[click](https://a.b", 19);
    const result = tryInlineTransform(editor, ")");
    expect(result).toBe(true);
    const para = editor.children[0] as any;
    const linkEl = para.children.find((c: any) => c.type === "link");
    expect(linkEl).toBeDefined();
    expect(linkEl.url).toBe("https://a.b");
    expect(linkEl.children[0].text).toBe("click");
  });

  it("IT-07: mid-word _ does not trigger", () => {
    const editor = editorWith("foo_bar", 7);
    const result = tryInlineTransform(editor, "_");
    expect(result).toBe(false);
  });

  it("IT-09: empty content ** does not transform", () => {
    const editor = editorWith("*", 1);
    const result = tryInlineTransform(editor, "*");
    expect(result).toBe(false);
  });

  describe("opener preceded by punctuation", () => {
    it("backtick opener after ( triggers code", () => {
      const editor = editorWith("(`foo bar", 9);
      const result = tryInlineTransform(editor, "`");
      expect(result).toBe(true);
      const leaves = getLeaves(editor);
      expect(
        leaves.some((l: any) => l.code === true && l.text === "foo bar"),
      ).toBe(true);
    });

    it("backtick closer typed before ) triggers code", () => {
      const editor = editorWith("(foo `bar baz)", 13);
      const result = tryInlineTransform(editor, "`");
      expect(result).toBe(true);
      const leaves = getLeaves(editor);
      expect(
        leaves.some((l: any) => l.code === true && l.text === "bar baz"),
      ).toBe(true);
    });

    it("* opener after ( triggers italic", () => {
      const editor = editorWith("(*it", 4);
      const result = tryInlineTransform(editor, "*");
      expect(result).toBe(true);
      const leaves = getLeaves(editor);
      expect(
        leaves.some((l: any) => l.italic === true && l.text === "it"),
      ).toBe(true);
    });

    it("** opener after ( triggers bold", () => {
      const editor = editorWith("(**bold*", 8);
      const result = tryInlineTransform(editor, "*");
      expect(result).toBe(true);
      const leaves = getLeaves(editor);
      expect(
        leaves.some((l: any) => l.bold === true && l.text === "bold"),
      ).toBe(true);
    });

    it("~ opener after ( triggers strikethrough", () => {
      const editor = editorWith("(~st", 4);
      const result = tryInlineTransform(editor, "~");
      expect(result).toBe(true);
      const leaves = getLeaves(editor);
      expect(
        leaves.some((l: any) => l.strikethrough === true && l.text === "st"),
      ).toBe(true);
    });

    it('backtick opener after " triggers code', () => {
      const editor = editorWith('"`quoted', 8);
      const result = tryInlineTransform(editor, "`");
      expect(result).toBe(true);
      const leaves = getLeaves(editor);
      expect(
        leaves.some((l: any) => l.code === true && l.text === "quoted"),
      ).toBe(true);
    });

    it("[text](url) after ( creates a link", () => {
      const editor = editorWith("([docs](https://a.b", 19);
      const result = tryInlineTransform(editor, ")");
      expect(result).toBe(true);
      const para = editor.children[0] as any;
      const linkEl = para.children.find((c: any) => c.type === "link");
      expect(linkEl).toBeDefined();
      expect(linkEl.url).toBe("https://a.b");
    });

    it("] after ([label scaffolds the link syntax", () => {
      const editor = editorWith("([docs", 6);
      const result = tryInlineTransform(editor, "]");
      expect(result).toBe(true);
    });

    it("mid-word backtick opener does not trigger", () => {
      const editor = editorWith("x`y", 3);
      const result = tryInlineTransform(editor, "`");
      expect(result).toBe(false);
    });

    it("] after [[label still rejects (wikilink guard)", () => {
      const editor = editorWith("[[foo", 5);
      const result = tryInlineTransform(editor, "]");
      expect(result).toBe(false);
    });
  });

  it("does not transform in code-block context", () => {
    const editor = withHistory(createEditor());
    editor.children = [{ type: "code-block", children: [{ text: "*a" }] }];
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 2 },
    });
    const result = tryInlineTransform(editor, "*");
    expect(result).toBe(false);
  });
});
