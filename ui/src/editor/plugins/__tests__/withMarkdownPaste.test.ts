import { createEditor, type Editor } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it, vi } from "vitest";
import { withSchema } from "#/editor/schema/withSchema";
import { withMarkdownPaste } from "../withMarkdownPaste";

/**
 * Build a test editor with a stubbed base insertData (the slot withReact would
 * normally fill). withMarkdownPaste captures this stub as its fallback.
 */
function makeEditor() {
  const editor = withSchema(withHistory(createEditor()));
  const base = vi.fn();
  editor.insertData = base;
  withMarkdownPaste(editor);
  return { editor, base };
}

function fakeData(parts: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => parts[type] ?? "",
  } as unknown as DataTransfer;
}

function emptyParagraph(editor: Editor) {
  editor.children = [{ type: "paragraph", children: [{ text: "" }] }];
  editor.selection = {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  };
}

describe("withMarkdownPaste", () => {
  it("MP-01: pasting `## Title` produces a heading", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({ "text/plain": "## Title" }));
    const node = editor.children[0] as any;
    expect(node.type).toBe("heading");
    expect(node.level).toBe(2);
    expect(node.children[0].text).toBe("Title");
    expect(base).not.toHaveBeenCalled();
  });

  it("MP-02: pasting multi-block markdown produces a heading + bulleted list", () => {
    const { editor } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({ "text/plain": "# H\n\n- a\n- b" }));
    expect((editor.children[0] as any).type).toBe("heading");
    const list = editor.children[1] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children).toHaveLength(2);
  });

  it("MP-03: pasting `**bold**` mid-paragraph merges inline", () => {
    const { editor } = makeEditor();
    editor.children = [{ type: "paragraph", children: [{ text: "ab" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 1 },
    };
    editor.insertData(fakeData({ "text/plain": "**bold**" }));
    expect(editor.children).toHaveLength(1);
    const para = editor.children[0] as any;
    expect(para.type).toBe("paragraph");
    const bold = para.children.find((c: any) => c.bold === true);
    expect(bold.text).toBe("bold");
  });

  it("MP-04: an internal slate fragment defers to base insertData", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(
      fakeData({
        "application/x-slate-fragment": "encoded-fragment",
        "text/plain": "## Title",
      }),
    );
    expect(base).toHaveBeenCalledTimes(1);
    // markdown path did NOT run: still a single empty paragraph
    expect((editor.children[0] as any).type).toBe("paragraph");
  });

  it("MP-05: pasting inside a code-block defers to base (literal paste)", () => {
    const { editor, base } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    const data = fakeData({ "text/plain": "## Title" });
    editor.insertData(data);
    // The guard took the code-block branch: base received the original
    // DataTransfer and the markdown path never ran (code-block untouched).
    expect(base).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith(data);
    expect((editor.children[0] as any).type).toBe("code-block");
    expect((editor.children[0] as any).children[0].text).toBe("");
  });

  it("MP-06: a paste with no text/plain defers to base", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({}));
    expect(base).toHaveBeenCalledTimes(1);
  });
});
