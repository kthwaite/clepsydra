import { createEditor, type Descendant, Editor, Node, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate } from "#/editor/convert";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withSchema } from "#/editor/schema/withSchema";
import {
  applyBlockConversion,
  type BlockConversion,
} from "../blockConversions";

function fromMd(md: string): Editor {
  const editor = withHistory(withOutliner(withSchema(createEditor())));
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor;
}

type El = { type?: string; checked?: boolean; children?: El[]; text?: string };

/** One line per item: list type, checkbox, text; two spaces per nesting level. */
function outline(nodes: Descendant[], depth = 0): string[] {
  const lines: string[] = [];
  for (const node of nodes as El[]) {
    if (node.type === "bulleted-list" || node.type === "numbered-list") {
      const marker = node.type === "bulleted-list" ? "b" : "n";
      for (const item of node.children ?? []) {
        const box =
          item.checked === undefined ? "" : item.checked ? "[x]" : "[ ]";
        const kids = item.children ?? [];
        const lead = kids[0];
        lines.push(
          `${"  ".repeat(depth)}${marker}${box} ${
            lead?.type === "paragraph"
              ? Node.string(lead as Node)
              : `<${lead?.type}>`
          }`,
        );
        lines.push(...outline(kids.slice(1) as Descendant[], depth + 1));
      }
    } else if (node.type === "paragraph") {
      lines.push(`${"  ".repeat(depth)}p ${Node.string(node as Node)}`);
    }
  }
  return lines;
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

const BULLET: BlockConversion = { type: "bulleted-list" };
const NUMBER: BlockConversion = { type: "numbered-list" };
const TASK: BlockConversion = { type: "task" };

describe("a list command on a line that is already a list item", () => {
  it("/bullet on a bullet leaves it one bullet", () => {
    const editor = fromMd("- aaa\n- bbb");
    slash(editor, "aaa", BULLET);
    expect(outline(editor.children)).toEqual(["b ", "b bbb"]);
  });

  it("/bullet on a bullet with kids keeps them under it", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    slash(editor, "aaa", BULLET);
    expect(outline(editor.children)).toEqual(["b ", "  b kid", "b bbb"]);
  });

  it("/task on a bullet makes that item a task", () => {
    const editor = fromMd("- aaa\n  - kid");
    slash(editor, "aaa", TASK);
    expect(outline(editor.children)).toEqual(["b[ ] ", "  b kid"]);
  });

  it("/task on a task keeps its state", () => {
    const editor = fromMd("- [x] aaa");
    slash(editor, "aaa", TASK);
    expect(outline(editor.children)).toEqual(["b[x] "]);
  });

  it("/task on a numbered item stays numbered", () => {
    const editor = fromMd("1. aaa");
    slash(editor, "aaa", TASK);
    expect(outline(editor.children)).toEqual(["n[ ] "]);
  });

  it("/number on the only bullet changes its list", () => {
    const editor = fromMd("- aaa");
    slash(editor, "aaa", NUMBER);
    expect(outline(editor.children)).toEqual(["n "]);
  });

  it("/number on a middle bullet splits the list around it", () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    slash(editor, "bbb", NUMBER);
    expect(outline(editor.children)).toEqual(["b aaa", "n ", "b ccc"]);
    expect(editor.children).toHaveLength(3);
  });

  it("/number on a nested bullet stays at its depth", () => {
    const editor = fromMd("- top\n  - aaa\n  - bbb");
    slash(editor, "aaa", NUMBER);
    expect(outline(editor.children)).toEqual(["b top", "  n ", "  b bbb"]);
  });

  it("/number on a bullet keeps its kids and its checkbox", () => {
    const editor = fromMd("- [x] aaa\n  - kid");
    slash(editor, "aaa", NUMBER);
    expect(outline(editor.children)).toEqual(["n[x] ", "  b kid"]);
  });

  it("/number joins a numbered list above", () => {
    const editor = fromMd("1. aaa\n\n* bbb");
    slash(editor, "bbb", NUMBER);
    expect(editor.children).toHaveLength(1);
    expect(outline(editor.children)).toEqual(["n aaa", "n "]);
  });

  it("removes the typed slash and keeps the caret in the item", () => {
    const editor = fromMd("- aaa\n- bbb");
    slash(editor, "aaa", TASK);
    Editor.insertText(editor, "Z");
    expect(outline(editor.children)).toEqual(["b[ ] Z", "b bbb"]);
  });

  it("is one undo", async () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    slash(editor, "bbb", NUMBER);
    await Promise.resolve();
    expect(editor.children).toHaveLength(3);
    HistoryEditor.undo(editor as HistoryEditor);
    await Promise.resolve();
    expect(outline(editor.children)).toEqual(["b aaa", "b /", "b ccc"]);
  });
});

describe("a list command on a line that is not an item's own line", () => {
  it("nests a new list under a later paragraph of an item", () => {
    const editor = fromMd("- aaa\n\n  par");
    slash(editor, "par", BULLET);
    expect(outline(editor.children)).toEqual(["b aaa", "  b "]);
  });

  it("wraps a top-level paragraph", () => {
    const editor = fromMd("aaa");
    slash(editor, "aaa", BULLET);
    expect(outline(editor.children)).toEqual(["b "]);
  });
});
