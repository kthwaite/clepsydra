import {
  createEditor,
  type Descendant,
  Element as SlateElement,
  Editor,
  Node,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "../../withOutliner";
import { withAutoformat } from "../withAutoformat";
import { withSchema } from "../../../schema/withSchema";

function makeEditor(value?: any[]) {
  const editor = withAutoformat(withOutliner(withHistory(createEditor())));
  editor.children = value ?? [{ type: "paragraph", children: [{ text: "" }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  });
  return editor;
}

function makeSchemaEditor(value?: Descendant[]) {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = value ?? [
    { type: "paragraph", children: [{ text: "" }] },
  ];
  Transforms.select(editor, Editor.end(editor, [0]));
  return editor;
}

function type(editor: Editor, text: string) {
  for (const ch of text) {
    editor.insertText(ch);
  }
}

function elementChildren(node: Descendant): Descendant[] {
  if (!SlateElement.isElement(node)) {
    throw new Error("Expected an element node");
  }
  return node.children;
}

function isFootnoteDefinition(
  node: Descendant,
  identifier?: string,
): boolean {
  return (
    SlateElement.isElement(node) &&
    node.type === "footnote-def" &&
    (identifier === undefined || node.identifier === identifier)
  );
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

    it("] after [label inserts () and places the caret inside", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");

      expect(Node.string(editor.children[0])).toBe("[Example]()");
      expect(editor.selection).toEqual({
        anchor: { path: [0, 0], offset: "[Example](".length },
        focus: { path: [0, 0], offset: "[Example](".length },
      });
    });

    it("overtype-closing the inserted ) creates a link without storing the closer", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");
      type(editor, "https://example.com)");

      const children = (editor.children[0] as any).children;
      const link = children.find((child: any) => child.type === "link");
      expect(link).toMatchObject({
        type: "link",
        url: "https://example.com",
        children: [{ text: "Example" }],
      });
      expect(Node.string(editor.children[0])).toBe("Example");
    });

    it("leaves an empty link destination as literal markdown", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");
      editor.insertText(")");

      expect(Node.string(editor.children[0])).toBe("[Example]()");
      expect(
        (editor.children[0] as any).children.some(
          (child: any) => child.type === "link",
        ),
      ).toBe(false);
    });

    it("one undo reverses link-label continuation", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example");
      editor.insertText("]");

      editor.undo();

      expect(Node.string(editor.children[0])).toBe("[Example");
    });
    it("does not run bracket shortcuts inside inline code", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "[^code", code: true }] },
      ]);
      editor.insertText("]");

      expect(Node.string(editor.children[0])).toBe("[^code]");
      expect(editor.children).toHaveLength(1);
    });

    it("does not run bracket shortcuts inside a code block", () => {
      const editor = makeSchemaEditor([
        {
          type: "code-block",
          language: null,
          children: [{ text: "[^code" }],
        },
      ]);
      editor.insertText("]");

      expect(Node.string(editor.children[0])).toBe("[^code]");
      expect(editor.children).toHaveLength(1);
    });

    it("[^id] delivered as one composed string creates a reference and definition", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[^id]");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "id",
      });
    });

    it("[^id]( delivered as one composed string still creates a footnote", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[^id](");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "id",
      });
    });

    it("[label] delivered as one composed string adds exactly one destination pair", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label]");

      expect(Node.string(editor.children[0])).toBe("[label]()");
    });

    it("[label](url) delivered as one composed string creates a link directly", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label](url)");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "link",
            url: "url",
            children: [{ text: "label" }],
          }),
        ]),
      );
      expect(Node.string(editor.children[0])).toBe("label");
    });

    it("[label]() delivered as one composed string remains unchanged", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label]()");

      expect(Node.string(editor.children[0])).toBe("[label]()");
    });

    it("[label](unfinished delivered as one composed string remains unchanged", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label](unfinished");

      expect(Node.string(editor.children[0])).toBe("[label](unfinished");
    });

    it("composed text without a shortcut keeps the caret at the end", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "*literal " }] },
      ]);
      editor.insertText("composed");

      expect(Node.string(editor.children[0])).toBe("*literal composed");
      expect(editor.selection).toEqual({
        anchor: { path: [0, 0], offset: "*literal composed".length },
        focus: { path: [0, 0], offset: "*literal composed".length },
      });
    });
  });

  describe("footnote shortcut", () => {
    it("creates a reference and one matching definition at document end", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^1]");

      const children = elementChildren(editor.children[0]);
      expect(children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "1" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "1",
        children: [{ text: "" }],
      });
    });

    it("keeps the caret after the inline reference", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^1]");
      type(editor, "after");

      const children = elementChildren(editor.children[0]);
      const refIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) && child.type === "footnote-ref",
      );
      expect(refIndex).toBeGreaterThanOrEqual(0);
      expect(children.slice(refIndex + 1)).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "after" })]),
      );
    });

    it("reuses an existing matching definition", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "" }] },
        {
          type: "footnote-def",
          identifier: "1",
          children: [{ text: "body" }],
        },
        { type: "paragraph", children: [{ text: "tail" }] },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: 0 });
      type(editor, "[^1]");

      expect(
        editor.children.filter((node) => isFootnoteDefinition(node, "1")),
      ).toHaveLength(1);
      expect(editor.children[1]).toMatchObject({
        children: [{ text: "body" }],
      });
    });

    it("multiple references share one definition", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^same] [^same]");

      expect(
        editor.children.filter((node) => isFootnoteDefinition(node, "same")),
      ).toHaveLength(1);
    });

    it("leaves empty footnote and link labels literal", () => {
      const footnote = makeSchemaEditor();
      type(footnote, "[^]");
      expect(Node.string(footnote.children[0])).toBe("[^]");

      const link = makeSchemaEditor();
      type(link, "[]");
      expect(Node.string(link.children[0])).toBe("[]");
    });

    it("one undo removes both the reference shortcut and its new definition", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^undo");
      editor.insertText("]");

      editor.undo();

      expect(Node.string(editor.children[0])).toBe("[^undo");
      expect(
        editor.children.some((node) => isFootnoteDefinition(node)),
      ).toBe(false);
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
