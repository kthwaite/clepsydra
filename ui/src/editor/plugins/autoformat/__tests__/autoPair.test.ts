import { createEditor, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { tryAutoPair, tryOvertype } from "../autoPair";

function editorWith(text: string, offset: number) {
  const editor = withHistory(createEditor());
  editor.children = [{ type: "paragraph", children: [{ text }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset },
    focus: { path: [0, 0], offset },
  });
  return editor;
}

function editorWithSelection(
  text: string,
  anchorOffset: number,
  focusOffset: number,
) {
  const editor = withHistory(createEditor());
  editor.children = [{ type: "paragraph", children: [{ text }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: anchorOffset },
    focus: { path: [0, 0], offset: focusOffset },
  });
  return editor;
}

function getText(editor: Editor): string {
  return (editor.children[0] as any).children[0].text;
}

function getCursorOffset(editor: Editor): number {
  return editor.selection!.anchor.offset;
}

describe("tryOvertype", () => {
  it("AP-03: advances cursor past closing * instead of duplicating", () => {
    const editor = editorWith("*hello*", 6);
    const result = tryOvertype(editor, "*");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("*hello*");
    expect(getCursorOffset(editor)).toBe(7);
  });

  it("does not overtype when next char differs", () => {
    const editor = editorWith("*hello", 5);
    const result = tryOvertype(editor, "*");
    expect(result).toBe(false);
  });

  it("overtypes ] character", () => {
    const editor = editorWith("[text]", 5);
    const result = tryOvertype(editor, "]");
    expect(result).toBe(true);
    expect(getCursorOffset(editor)).toBe(6);
  });

  it("overtypes ) character", () => {
    const editor = editorWith("(url)", 4);
    const result = tryOvertype(editor, ")");
    expect(result).toBe(true);
    expect(getCursorOffset(editor)).toBe(5);
  });

  it("overtypes ~ character", () => {
    const editor = editorWith("~hello~", 6);
    const result = tryOvertype(editor, "~");
    expect(result).toBe(true);
    expect(getCursorOffset(editor)).toBe(7);
  });
});

describe("tryAutoPair", () => {
  it("AP-01: typing * inserts *|* (paired)", () => {
    const editor = editorWith("", 0);
    const result = tryAutoPair(editor, "*");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("**");
    expect(getCursorOffset(editor)).toBe(1);
  });

  it("AP-01: typing _ inserts _|_", () => {
    const editor = editorWith("", 0);
    const result = tryAutoPair(editor, "_");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("__");
    expect(getCursorOffset(editor)).toBe(1);
  });

  it("typing ~ inserts ~|~", () => {
    const editor = editorWith("", 0);
    const result = tryAutoPair(editor, "~");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("~~");
    expect(getCursorOffset(editor)).toBe(1);
  });

  it("AP-02: auto-pair fires at position after **", () => {
    const editor = editorWith("**", 2);
    const result = tryAutoPair(editor, "*");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("****");
    expect(getCursorOffset(editor)).toBe(3);
  });

  it("AP-04: skips auto-pair for mid-word *", () => {
    const editor = editorWith("hello", 5);
    const result = tryAutoPair(editor, "*");
    expect(result).toBe(false);
  });

  it("AP-04: skips auto-pair for mid-word _", () => {
    const editor = editorWith("foo", 3);
    const result = tryAutoPair(editor, "_");
    expect(result).toBe(false);
  });

  it("skips auto-pair when immediately before same char", () => {
    const editor = editorWith("*", 0);
    const result = tryAutoPair(editor, "*");
    expect(result).toBe(false);
  });

  it("AP-05: wraps selection with *", () => {
    const editor = editorWithSelection("hello world", 0, 5);
    const result = tryAutoPair(editor, "*");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("*hello* world");
  });

  it("AP-05: wraps selection with ~", () => {
    const editor = editorWithSelection("hello world", 0, 5);
    const result = tryAutoPair(editor, "~");
    expect(result).toBe(true);
    expect(getText(editor)).toBe("~hello~ world");
  });

  it("does not auto-pair unsupported chars like [", () => {
    const editor = editorWith("", 0);
    const result = tryAutoPair(editor, "[");
    expect(result).toBe(false);
  });

  it("does not auto-pair backtick", () => {
    const editor = editorWith("", 0);
    const result = tryAutoPair(editor, "`");
    expect(result).toBe(false);
  });
});
