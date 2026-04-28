import { createEditor, type Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { tryInlineTransform } from "../inlineTransforms";

function editorWith(text: string, offset: number) {
  const editor = withHistory(createEditor());
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
