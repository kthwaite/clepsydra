import { createEditor, Editor, Node, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "../../withOutliner";
import { withAutoformat } from "../withAutoformat";

function makeEditor(value?: any[]) {
  const editor = withAutoformat(withOutliner(withHistory(createEditor())));
  editor.children = value ?? [{ type: "paragraph", children: [{ text: "" }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  });
  return editor;
}

function type(editor: Editor, text: string) {
  for (const ch of text) {
    editor.insertText(ch);
  }
}

describe("withAutoformat integration", () => {
  describe("block transforms via insertText", () => {
    it("# + space converts to heading 1", () => {
      const editor = makeEditor();
      type(editor, "# ");
      expect((editor.children[0] as any).type).toBe("heading");
      expect((editor.children[0] as any).level).toBe(1);
    });

    it("- + space converts to bulleted list", () => {
      const editor = makeEditor();
      type(editor, "- ");
      const firstChild = editor.children[0] as any;
      expect(firstChild.type).toBe("bulleted-list");
    });

    it("--- converts to thematic break", () => {
      const editor = makeEditor();
      type(editor, "---");
      expect((editor.children[0] as any).type).toBe("thematic-break");
    });

    it("> + space converts to blockquote", () => {
      const editor = makeEditor();
      type(editor, "> ");
      expect((editor.children[0] as any).type).toBe("blockquote");
    });

    it("1. + space converts to numbered list", () => {
      const editor = makeEditor();
      type(editor, "1. ");
      expect((editor.children[0] as any).type).toBe("numbered-list");
    });
  });

  describe("inline transforms via insertText", () => {
    it("*text* applies italic", () => {
      const editor = makeEditor();
      type(editor, "*hello*");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(leaves.some((l: any) => l.italic && l.text === "hello")).toBe(
        true,
      );
    });

    it("~text~ applies strikethrough", () => {
      const editor = makeEditor();
      type(editor, "~hello~");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(
        leaves.some((l: any) => l.strikethrough && l.text === "hello"),
      ).toBe(true);
    });

    it("`text` applies code mark", () => {
      const editor = makeEditor();
      type(editor, "`code`");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(leaves.some((l: any) => l.code && l.text === "code")).toBe(true);
    });
  });

  describe("regression guards", () => {
    it("RG-03: / in https:// does not trigger slash", () => {
      const editor = makeEditor();
      type(editor, "https://");
      expect(Node.string(editor.children[0])).toBe("https://");
    });
  });

  describe("insertBreak", () => {
    it("RG-02: code fence ```ts + Enter creates code-block", () => {
      const editor = makeEditor();
      type(editor, "```ts");
      editor.insertBreak();
      expect((editor.children[0] as any).type).toBe("code-block");
      expect((editor.children[0] as any).language).toBe("ts");
    });

    it("Enter in list item creates new item", () => {
      const editor = makeEditor();
      type(editor, "- hello");
      editor.insertBreak();
      const list = editor.children[0] as any;
      expect(list.type).toBe("bulleted-list");
      expect(list.children.length).toBe(2);
    });
  });
});
