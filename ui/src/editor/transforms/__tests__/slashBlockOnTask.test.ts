import { createEditor, type Descendant, Editor, Node, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withSchema } from "#/editor/schema/withSchema";
import {
  applyBlockConversion,
  type BlockConversion,
} from "../blockConversions";

type El = {
  type?: string;
  checked?: boolean;
  properties?: Record<string, string>;
  children?: El[];
};

function fromMd(md: string): Editor {
  const editor = withHistory(withOutliner(withSchema(createEditor())));
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor;
}

function reloaded(editor: Editor): Descendant[] {
  const back = withSchema(createEditor());
  back.children = markdownToSlate(slateToMarkdown(editor.children));
  Editor.normalize(back, { force: true });
  return back.children;
}

/** What SlateEditor.executeSlashCommand does once `/` is the paragraph's text. */
function slash(editor: Editor, text: string, conversion: BlockConversion) {
  const entry = Array.from(
    Editor.nodes(editor, {
      at: [],
      match: (n) => (n as El).type === "paragraph" && Node.string(n) === text,
    }),
  )[0];
  if (!entry) throw new Error(`no paragraph ${text}`);
  const at = entry[1];
  Transforms.delete(editor, { at: Editor.range(editor, at) });
  Transforms.select(editor, Editor.start(editor, at));
  Editor.insertText(editor, "/");
  const { selection } = editor;
  if (!selection) throw new Error("no selection");
  applyBlockConversion(editor, {
    at,
    deleteRange: {
      anchor: { path: selection.anchor.path, offset: 0 },
      focus: selection.focus,
    },
    conversion,
  });
}

const firstItem = (nodes: Descendant[]) => (nodes[0] as El).children?.[0] as El;
const childTypes = (item: El) => item.children?.map((c) => c.type);

const H1: BlockConversion = { type: "heading", level: 1 };
const CODE: BlockConversion = { type: "code-block" };
const QUOTE: BlockConversion = { type: "blockquote" };
const DIVIDER: BlockConversion = { type: "thematic-break" };

describe("a slash block command on a task's own line", () => {
  it.each([
    ["/h1", H1, "heading"],
    ["/code", CODE, "code-block"],
    ["/quote", QUOTE, "blockquote"],
    ["/divider", DIVIDER, "thematic-break"],
  ])(
    "%s keeps the lead paragraph and goes after it",
    (_n, conversion, type) => {
      const editor = fromMd("- [x] aaa");
      slash(editor, "aaa", conversion);
      const item = firstItem(editor.children);
      expect(item.checked).toBe(true);
      expect(childTypes(item)?.slice(0, 2)).toEqual(["paragraph", type]);
    },
  );

  it("puts the caret in the new block", () => {
    const editor = fromMd("- [ ] aaa");
    slash(editor, "aaa", H1);
    Editor.insertText(editor, "Z");
    const item = firstItem(editor.children);
    expect(Node.string(item.children?.[0] as Node)).toBe("");
    expect(Node.string(item.children?.[1] as Node)).toBe("Z");
  });

  it("keeps kids after the new block", () => {
    const editor = fromMd("- [ ] aaa\n  - kid");
    slash(editor, "aaa", CODE);
    expect(childTypes(firstItem(editor.children))).toEqual([
      "paragraph",
      "code-block",
      "bulleted-list",
    ]);
  });

  it("is one undo", async () => {
    const editor = fromMd("- [x] aaa");
    slash(editor, "aaa", H1);
    await Promise.resolve();
    HistoryEditor.undo(editor as HistoryEditor);
    await Promise.resolve();
    expect(childTypes(firstItem(editor.children))).toEqual(["paragraph"]);
    expect(firstItem(editor.children).checked).toBe(true);
  });

  describe.each([
    ["/h1", H1, "heading"],
    ["/code", CODE, "code-block"],
  ])("%s after save and reload", (_n, conversion, type) => {
    it("keeps the checkbox and the block in the item", () => {
      const editor = fromMd("- [x] aaa");
      slash(editor, "aaa", conversion);
      const back = reloaded(editor);
      expect(back).toHaveLength(editor.children.length);
      const item = firstItem(back);
      expect(item.checked).toBe(true);
      expect(childTypes(item)?.slice(0, 2)).toEqual(["paragraph", type]);
    });

    it("keeps the checkbox, the kids and the block in the item", () => {
      const editor = fromMd("- [x] aaa\n  - kid");
      slash(editor, "aaa", conversion);
      const item = firstItem(reloaded(editor));
      expect(item.checked).toBe(true);
      expect(childTypes(item)).toEqual(["paragraph", type, "bulleted-list"]);
    });

    it("keeps properties too", () => {
      const editor = fromMd("- [x] aaa [due:: 2026-11-04]\n  - kid");
      slash(editor, "aaa", conversion);
      const item = firstItem(reloaded(editor));
      expect(item.checked).toBe(true);
      expect(item.properties).toEqual({ due: "2026-11-04" });
      expect(childTypes(item)).toEqual(["paragraph", type, "bulleted-list"]);
    });

    it("keeps typed text in the block", () => {
      const editor = fromMd("- [x] aaa [due:: 2026-11-04]");
      slash(editor, "aaa", conversion);
      Editor.insertText(editor, "Z");
      const item = firstItem(reloaded(editor));
      expect(item.properties).toEqual({ due: "2026-11-04" });
      expect(Node.string(item.children?.[1] as Node)).toBe("Z");
    });
  });
});

describe("a slash block command on a plain item's own line", () => {
  it("/h1 still leads the item", () => {
    const editor = fromMd("- aaa");
    slash(editor, "aaa", H1);
    expect(childTypes(firstItem(editor.children))).toEqual(["heading"]);
  });

  it("/code still leads the item", () => {
    const editor = fromMd("- aaa\n  - kid");
    slash(editor, "aaa", CODE);
    expect(childTypes(firstItem(editor.children))).toEqual([
      "code-block",
      "bulleted-list",
    ]);
  });
});
