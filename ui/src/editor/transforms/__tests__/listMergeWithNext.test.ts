import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withAutoformat } from "#/editor/plugins/autoformat/withAutoformat";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withSchema } from "#/editor/schema/withSchema";
import { applyBlockConversion, applySelectionList } from "../blockConversions";

function fromMd(md: string): Editor {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor;
}

const toMd = (editor: Editor) => slateToMarkdown(editor.children);

function topLevelTypes(editor: Editor) {
  return editor.children.map((n) => (n as { type?: string }).type);
}

/** Range over the whole of the only text leaf of a top-level paragraph. */
function selectBlock(editor: Editor, path: number[]) {
  Transforms.select(editor, Editor.range(editor, path));
}

function bubble(editor: Editor, list: "bulleted-list" | "numbered-list") {
  Editor.withoutNormalizing(editor, () => applySelectionList(editor, list));
}

const flush = () => Promise.resolve();

describe("a line that becomes a list between two same-type lists", () => {
  it("joins both lists when typing the - marker", () => {
    const editor = fromMd("- one\n\npara\n\n* two");
    Transforms.select(editor, Editor.start(editor, [1]));
    Editor.insertText(editor, "-");
    Editor.insertText(editor, " ");
    expect(topLevelTypes(editor)).toEqual(["bulleted-list"]);
    expect(toMd(editor)).toBe("* one\n* para\n* two\n");
  });

  it("joins both lists when typing the 1. marker", () => {
    const editor = fromMd("1. one\n\npara\n\n1) two");
    Transforms.select(editor, Editor.start(editor, [1]));
    Editor.insertText(editor, "1.");
    Editor.insertText(editor, " ");
    expect(topLevelTypes(editor)).toEqual(["numbered-list"]);
    expect(toMd(editor)).toBe("1. one\n2. para\n3. two\n");
  });

  it("joins the list below when there is none above", () => {
    const editor = fromMd("para\n\n- two");
    Transforms.select(editor, Editor.start(editor, [0]));
    Editor.insertText(editor, "-");
    Editor.insertText(editor, " ");
    expect(toMd(editor)).toBe("* para\n* two\n");
  });

  it("joins both lists from the slash menu", () => {
    const editor = fromMd("- one\n\nX\n\n* two");
    applyBlockConversion(editor, {
      at: [1],
      deleteRange: Editor.range(editor, [1]),
      conversion: { type: "bulleted-list" },
    });
    expect(topLevelTypes(editor)).toEqual(["bulleted-list"]);
    expect(editor.children).toHaveLength(1);
  });

  it("joins both lists from the selection bubble", () => {
    const editor = fromMd("1. one\n\nmid\n\n1) two");
    selectBlock(editor, [1]);
    bubble(editor, "numbered-list");
    expect(toMd(editor)).toBe("1. one\n2. mid\n3. two\n");
  });

  it("joins both lists for a task", () => {
    const editor = fromMd("- one\n\nX\n\n* two");
    applyBlockConversion(editor, {
      at: [1],
      deleteRange: Editor.range(editor, [1]),
      conversion: { type: "task", checked: false },
    });
    expect(editor.children).toHaveLength(1);
  });

  it("keeps a task's checkbox in the list below", () => {
    const editor = fromMd("para\n\n1. [ ] job");
    Transforms.select(editor, Editor.start(editor, [0]));
    Editor.insertText(editor, "1.");
    Editor.insertText(editor, " ");
    expect(toMd(editor)).toBe("1. para\n2. [ ] job\n");
  });

  it("leaves a list of another type alone", () => {
    const editor = fromMd("- one\n\npara\n\n1. two");
    Transforms.select(editor, Editor.start(editor, [1]));
    Editor.insertText(editor, "-");
    Editor.insertText(editor, " ");
    expect(topLevelTypes(editor)).toEqual(["bulleted-list", "numbered-list"]);
    expect(toMd(editor)).toBe("* one\n* para\n\n1. two\n");
  });

  it("keeps the caret in the converted line", () => {
    const editor = fromMd("- one\n\npara\n\n* two");
    Transforms.select(editor, Editor.start(editor, [1]));
    Editor.insertText(editor, "-");
    Editor.insertText(editor, " ");
    Editor.insertText(editor, "Z");
    expect(toMd(editor)).toBe("* one\n* Zpara\n* two\n");
  });

  it("is one undo", async () => {
    const before = "- one\n\nX\n\n* two";
    const editor = fromMd(before);
    const start: Descendant[] = JSON.parse(JSON.stringify(editor.children));
    await flush();
    applyBlockConversion(editor, {
      at: [1],
      conversion: { type: "bulleted-list" },
    });
    await flush();
    expect(editor.children).toHaveLength(1);
    HistoryEditor.undo(editor as HistoryEditor);
    await flush();
    expect(editor.children).toEqual(start);
  });
});

describe("re-applying a list inside a list of that type", () => {
  it("keeps the numbering when the selection is mid-list", () => {
    const editor = fromMd("1. aaa\n2. bbb\n3. ccc");
    selectBlock(editor, [0, 1, 0]);
    bubble(editor, "numbered-list");
    expect(toMd(editor)).toBe("1. aaa\n2. bbb\n3. ccc\n");
  });

  it("keeps one list when the selection is at the start", () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    selectBlock(editor, [0, 0, 0]);
    bubble(editor, "bulleted-list");
    expect(editor.children).toHaveLength(1);
  });

  it("keeps one list when the selection is at the end", () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    selectBlock(editor, [0, 2, 0]);
    bubble(editor, "bulleted-list");
    expect(editor.children).toHaveLength(1);
  });

  it("keeps one list when the selection spans two items", () => {
    const editor = fromMd("1. aaa\n2. bbb\n3. ccc");
    Transforms.select(editor, {
      anchor: Editor.start(editor, [0, 0, 0]),
      focus: Editor.end(editor, [0, 1, 0]),
    });
    bubble(editor, "numbered-list");
    expect(toMd(editor)).toBe("1. aaa\n2. bbb\n3. ccc\n");
  });

  it("still splits when the type changes", () => {
    const editor = fromMd("1. aaa\n2. bbb\n3. ccc");
    selectBlock(editor, [0, 1, 0]);
    bubble(editor, "bulleted-list");
    expect(toMd(editor)).toBe("1. aaa\n\n* bbb\n\n1. ccc\n");
  });
});
