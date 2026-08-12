import { createEditor, type Editor, Element as SlateElement } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it, vi } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { withSchema } from "#/editor/schema/withSchema";
import { withAutoformat } from "../autoformat/withAutoformat";
import { withMarkdownPaste } from "../withMarkdownPaste";
import { withMathClipboard } from "../withMathClipboard";

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

function makeAutoformatEditor() {
  const editor = withHistory(withAutoformat(withSchema(createEditor())));
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

function mutableData(): DataTransfer {
  const parts = new Map<string, string>();
  return {
    getData: (type: string) => parts.get(type) ?? "",
    setData: (type: string, value: string) => {
      parts.set(type, value);
    },
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

  it("MP-04b: a copied math fragment keeps the internal paste fast path", () => {
    const source = withSchema(createEditor());
    source.children = [
      {
        type: "paragraph",
        children: [
          {
            type: "inline-math",
            tex: "x",
            delimiter: "\\(",
            children: [{ text: "" }],
          },
        ],
      },
    ];
    source.selection = {
      anchor: { path: [0, 0, 0], offset: 0 },
      focus: { path: [0, 0, 0], offset: 0 },
    };
    source.setFragmentData = (data) => {
      data.setData("application/x-slate-fragment", "encoded-math-fragment");
      data.setData("text/plain", "");
    };
    withMathClipboard(source);
    const data = mutableData();
    source.setFragmentData(data, "copy");

    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(data);

    expect(data.getData("text/plain")).toBe(String.raw`\(x\)`);
    expect(base).toHaveBeenCalledWith(data);
    expect(editor.children).toEqual([
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });

  it("MP-05: pasting inside a code-block inserts the text literally", () => {
    const { editor, base } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    editor.insertData(fakeData({ "text/plain": "## Title" }));
    // Markdown path never ran (no heading) and base never ran (base would
    // line-split): the raw text landed inside the code-block. documentRules
    // appends a trailing paragraph after a document-final code block, so
    // assert on code-block count rather than total children.
    expect(base).not.toHaveBeenCalled();
    const blocks = editor.children as any[];
    expect(blocks.filter((n) => n.type === "code-block")).toHaveLength(1);
    expect(blocks[0].type).toBe("code-block");
    expect(blocks[0].children[0].text).toBe("## Title");
  });

  it("MP-05b: multiline paste inside a code-block stays one block", () => {
    const { editor, base } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    editor.insertData(
      fakeData({ "text/plain": "const a = 1;\nconst b = 2;\nconst c = 3;" }),
    );
    expect(base).not.toHaveBeenCalled();
    const blocks = editor.children as any[];
    expect(blocks.filter((n) => n.type === "code-block")).toHaveLength(1);
    expect(blocks[0].type).toBe("code-block");
    expect(blocks[0].children[0].text).toBe(
      "const a = 1;\nconst b = 2;\nconst c = 3;",
    );
  });

  it("MP-05c: CRLF line endings are normalized to LF inside a code-block", () => {
    const { editor } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    editor.insertData(fakeData({ "text/plain": "a\r\nb\rc" }));
    expect((editor.children[0] as any).children[0].text).toBe("a\nb\nc");
  });

  it("MP-05e: an internal fragment pasted inside a code-block inserts its plain text", () => {
    const { editor, base } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    // Internal copies carry both a slate fragment and its text/plain
    // rendering; inside a code-block the plain text wins (fragment paste
    // would splice block nodes into the code-block).
    editor.insertData(
      fakeData({
        "application/x-slate-fragment": "encoded-fragment",
        "text/plain": "line1\nline2",
      }),
    );
    expect(base).not.toHaveBeenCalled();
    const blocks = editor.children as any[];
    expect(blocks.filter((n) => n.type === "code-block")).toHaveLength(1);
    expect(blocks[0].children[0].text).toBe("line1\nline2");
  });

  it("MP-05d: a non-text paste inside a code-block still defers to base", () => {
    const { editor, base } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    const data = fakeData({});
    editor.insertData(data);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith(data);
  });

  it("MP-06: a paste with no text/plain defers to base", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({}));
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("MP-07: a URL pasted into a generated link scaffold persists as Markdown", () => {
    const { editor } = makeAutoformatEditor();
    const url = "https://github.com/PrimeIntellect-ai/prime-agent";
    editor.children = [
      { type: "paragraph", children: [{ text: "[prime agent]()" }] },
    ];
    editor.selection = {
      anchor: { path: [0, 0], offset: "[prime agent](".length },
      focus: { path: [0, 0], offset: "[prime agent](".length },
    };

    editor.insertData(fakeData({ "text/plain": url }));

    expect(slateToMarkdown(editor.children).trim()).toBe(
      `[prime agent](${url})`,
    );
    const paragraph = editor.children[0];
    if (!SlateElement.isElement(paragraph)) {
      throw new Error("expected a paragraph element");
    }
    expect(
      paragraph.children.find(
        (child) => SlateElement.isElement(child) && child.type === "link",
      ),
    ).toMatchObject({
      type: "link",
      url,
      children: [{ text: "prime agent" }],
    });
  });
});
