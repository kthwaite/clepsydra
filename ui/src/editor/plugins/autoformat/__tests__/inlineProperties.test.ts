import { createEditor, type Descendant, Editor, Node, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMdast } from "../../../convert/slate-to-mdast";
import {
  matchTrailingInlineProperty,
  TASK_PROPERTY_KEYS,
} from "../../../properties";
import { withSchema } from "../../../schema/withSchema";
import { withOutliner } from "../../withOutliner";
import { withAutoformat } from "../withAutoformat";

// Import types so module augmentation is active
import "../../../types";

function makeEditor(value?: Descendant[]) {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = value ?? [{ type: "paragraph", children: [{ text: "" }] }];
  Transforms.select(editor, Editor.end(editor, [0]));
  return editor;
}

function makeTaskEditor(text = "write the plan", extra: object = {}) {
  const editor = makeEditor([
    {
      type: "bulleted-list",
      children: [
        {
          type: "list-item",
          checked: false,
          ...extra,
          children: [{ type: "paragraph", children: [{ text }] }],
        },
      ],
    } as unknown as Descendant,
  ]);
  Transforms.select(editor, Editor.end(editor, [0, 0, 0]));
  return editor;
}

function type(editor: Editor, text: string) {
  for (const ch of text) {
    editor.insertText(ch);
  }
}

function taskItem(editor: Editor): any {
  return (editor.children[0] as any).children[0];
}

describe("inline property syntax", () => {
  it("matches a trailing [key:: value] pair", () => {
    expect(matchTrailingInlineProperty("write it [due:: 2026-08-14]")).toEqual({
      index: 9,
      key: "due",
      value: "2026-08-14",
    });
  });

  it("requires whitespace after the :: separator", () => {
    expect(matchTrailingInlineProperty("[due::2026-08-14]")).toBeNull();
  });

  it("rejects a pair that is not at the end of the text", () => {
    expect(matchTrailingInlineProperty("[due:: 2026-08-14] tail")).toBeNull();
  });

  it("names the three keys the task affordances render", () => {
    expect(TASK_PROPERTY_KEYS).toEqual(["due", "scheduled", "priority"]);
  });
});

describe("typed [key:: value] autoformat", () => {
  it("records the property on the task item and removes the typed text", () => {
    const editor = makeTaskEditor();
    type(editor, " [due:: 2026-08-14]");

    const item = taskItem(editor);
    expect(item.properties).toEqual({ due: "2026-08-14" });
    expect(Node.string(item)).toBe("write the plan");
  });

  it("stores the property on the item, not its paragraph", () => {
    const editor = makeTaskEditor();
    type(editor, " [scheduled:: 2026-08-15]");

    const item = taskItem(editor);
    expect(item.properties).toEqual({ scheduled: "2026-08-15" });
    expect(item.children[0].properties).toBeUndefined();
  });

  it("wins over the link scaffold that used to mangle the syntax", () => {
    const editor = makeEditor();
    type(editor, "[due:: 2026-08-14]");

    const paragraph = editor.children[0] as any;
    expect(Node.string(paragraph)).toBe("");
    expect(paragraph.properties).toEqual({ due: "2026-08-14" });
    expect(paragraph.children.some((c: any) => c.type === "link")).toBe(false);
  });

  it("converts a property typed on a plain paragraph", () => {
    const editor = makeEditor();
    type(editor, "ship it [priority:: A]");

    const paragraph = editor.children[0] as any;
    expect(paragraph.properties).toEqual({ priority: "A" });
    expect(Node.string(paragraph)).toBe("ship it");
  });

  it("keeps the caret where the property text was", () => {
    const editor = makeEditor();
    type(editor, "ship it [priority:: A]");
    type(editor, " now");

    expect(Node.string(editor.children[0])).toBe("ship it now");
  });

  it("overwrites an existing value for the same key", () => {
    const editor = makeTaskEditor("write the plan", {
      properties: { due: "2026-08-01", priority: "B" },
    });
    type(editor, " [due:: 2026-08-14]");

    expect(taskItem(editor).properties).toEqual({
      due: "2026-08-14",
      priority: "B",
    });
  });

  it("still scaffolds a plain bracket label into link syntax", () => {
    const editor = makeEditor();
    type(editor, "[Example]");

    expect(Node.string(editor.children[0])).toBe("[Example]()");
    expect((editor.children[0] as any).properties).toBeUndefined();
  });

  it("scaffolds a link when :: has no following space", () => {
    const editor = makeEditor();
    type(editor, "[due::2026-08-14]");

    expect(Node.string(editor.children[0])).toBe("[due::2026-08-14]()");
    expect((editor.children[0] as any).properties).toBeUndefined();
  });

  it("does not trigger inside a code block", () => {
    const editor = makeEditor([
      { type: "code-block", children: [{ text: "" }] } as unknown as Descendant,
    ]);
    type(editor, "[due:: 2026-08-14]");

    const block = editor.children[0] as any;
    expect(Node.string(block)).toBe("[due:: 2026-08-14]");
    expect(block.properties).toBeUndefined();
  });

  it("does not trigger under an active code mark", () => {
    const editor = makeEditor([
      {
        type: "paragraph",
        children: [{ text: "[due:: 2026-08-14", code: true }],
      } as unknown as Descendant,
    ]);
    Transforms.select(editor, Editor.end(editor, [0]));
    editor.insertText("]");

    const paragraph = editor.children[0] as any;
    expect(Node.string(paragraph)).toBe("[due:: 2026-08-14]");
    expect(paragraph.properties).toBeUndefined();
  });

  it("converts a pair committed as one composed run (IME / autocorrect)", () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "task" }] } as Descendant,
    ]);
    Transforms.select(editor, Editor.end(editor, [0]));
    editor.insertText(" [due:: 2026-08-14]");

    const paragraph = editor.children[0] as any;
    expect(paragraph.properties).toEqual({ due: "2026-08-14" });
    expect(Node.string(paragraph)).toBe("task");
  });

  it("reverses the whole transform with a single undo", () => {
    const editor = makeTaskEditor();
    type(editor, " [due:: 2026-08-14]");

    editor.undo();

    const item = taskItem(editor);
    expect(item.properties).toBeUndefined();
    expect(Node.string(item)).toBe("write the plan [due:: 2026-08-14");
  });

  it("serializes a typed task property back to [key:: value] markdown", () => {
    const editor = makeTaskEditor();
    type(editor, " [due:: 2026-08-14]");

    expect(slateToMdast(editor.children).trim()).toBe(
      "* [ ] write the plan [due:: 2026-08-14]",
    );
  });
});
