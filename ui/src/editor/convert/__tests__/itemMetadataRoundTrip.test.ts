/**
 * A list item's metadata across saves. The serializer writes it onto the item's
 * first paragraph, so the loader has to find it and clean up after it there,
 * whatever other blocks the item holds. A file must reach a fixed point.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withAutoformat } from "#/editor/plugins/autoformat/withAutoformat";
import { withBlockVoidDeletion } from "#/editor/plugins/withBlockVoidDeletion";
import { withInlinePunctuationBoundary } from "#/editor/plugins/withInlinePunctuationBoundary";
import { withMarkdownPaste } from "#/editor/plugins/withMarkdownPaste";
import { withMathClipboard } from "#/editor/plugins/withMathClipboard";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withTables } from "#/editor/plugins/withTables";
import { withSchema } from "#/editor/schema/withSchema";

const save = (nodes: Descendant[]) =>
  slateToMarkdown(JSON.parse(JSON.stringify(nodes)));

type ItemShape = {
  properties?: Record<string, string>;
  blockId?: string;
  checked?: boolean;
  children: Array<{ type: string; children: Array<{ text?: string }> }>;
};

const firstItem = (nodes: Descendant[]) =>
  (nodes[0] as unknown as { children: ItemShape[] }).children[0];

const leadText = (nodes: Descendant[]) =>
  firstItem(nodes)
    .children[0].children.map((c) => c.text ?? "")
    .join("");

function expectFixedPoint(source: string) {
  const once = save(markdownToSlate(source));
  const twice = save(markdownToSlate(once));
  const thrice = save(markdownToSlate(twice));
  expect(twice).toBe(once);
  expect(thrice).toBe(once);
  return markdownToSlate(thrice);
}

describe.each<[string, string]>([
  ["a second paragraph", "- lead [k:: v]\n\n  more\n"],
  ["a code block", "- lead [k:: v]\n\n  ```\n  code\n  ```\n"],
  ["a blockquote", "- lead [k:: v]\n\n  > quoted\n"],
  ["a second paragraph and a child", "- lead [k:: v]\n\n  more\n\n  - kid\n"],
  ["only a child", "- lead [k:: v]\n  - kid\n"],
  ["nothing else", "- lead [k:: v]\n"],
])("a property on an item with %s", (_name, source) => {
  it("reaches a fixed point and keeps the text clean", () => {
    const loaded = expectFixedPoint(source);
    expect(firstItem(loaded).properties).toEqual({ k: "v" });
    expect(leadText(loaded)).toBe("lead");
  });
});

describe("a task with a property and a second block", () => {
  it("does not grow across saves", () => {
    const loaded = expectFixedPoint("- [ ] job [due:: 2026-01-01]\n\n  more\n");
    expect(firstItem(loaded).checked).toBe(false);
    expect(firstItem(loaded).properties).toEqual({ due: "2026-01-01" });
    expect(leadText(loaded)).toBe("job");
  });
});

describe("a property written in an item's later paragraph", () => {
  it("settles on the item with clean text", () => {
    const loaded = expectFixedPoint("- lead\n\n  more [k:: v]\n");
    expect(firstItem(loaded).properties).toEqual({ k: "v" });
    expect(leadText(loaded)).toBe("lead");
    expect(firstItem(loaded).children[1].children[0].text).toBe("more");
  });
});

describe.each<[string, string]>([
  ["a second paragraph, id on the lead", "- lead ^abcdefghij\n\n  more\n"],
  ["a second paragraph, id on the last", "- lead\n\n  more ^abcdefghij\n"],
  ["a blockquote", "- lead ^abcdefghij\n\n  > quoted\n"],
  ["nothing else", "- lead ^abcdefghij\n"],
])("a block id on an item with %s", (_name, source) => {
  it("survives every save and stays out of the text", () => {
    const loaded = expectFixedPoint(source);
    expect(firstItem(loaded).blockId).toBe("abcdefghij");
    expect(leadText(loaded)).toBe("lead");
  });
});

describe("a block id on a block with no text", () => {
  const emptyItem = {
    type: "bulleted-list",
    children: [
      {
        type: "list-item",
        blockId: "qqqqqqqqqq",
        children: [{ type: "paragraph", children: [{ text: "" }] }],
      },
    ],
  } as unknown as Descendant;

  it("stays an id on an empty item", () => {
    const loaded = expectFixedPoint(save([emptyItem]));
    expect(firstItem(loaded).blockId).toBe("qqqqqqqqqq");
    expect(leadText(loaded)).toBe("");
  });

  it("stays an id on an empty paragraph", () => {
    const paragraph = {
      type: "paragraph",
      blockId: "qqqqqqqqqq",
      children: [{ text: "" }],
    } as unknown as Descendant;
    const loaded = markdownToSlate(save([paragraph]));
    expect(loaded).toEqual([paragraph]);
    expect(save(loaded)).toBe(save([paragraph]));
  });

  it("does not take a line that is only caret text for an id", () => {
    const loaded = markdownToSlate("- ^abcdefghij\n");
    expect(firstItem(loaded).blockId).toBeUndefined();
    expect(leadText(loaded)).toBe("^abcdefghij");
  });
});

describe("metadata typed into an item with two paragraphs", () => {
  async function typedInto(paragraphIndex: number, keys: string) {
    const editor = withMathClipboard(
      withMarkdownPaste(
        withReact(
          withInlinePunctuationBoundary(
            withHistory(
              withAutoformat(
                withOutliner(
                  withBlockVoidDeletion(withTables(withSchema(createEditor()))),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              { type: "paragraph", children: [{ text: "lead" }] },
              { type: "paragraph", children: [{ text: "more" }] },
            ],
          },
        ],
      },
    ] as Descendant[];
    Transforms.select(editor, Editor.end(editor, [0, 0, paragraphIndex]));
    for (const key of keys) {
      Editor.insertText(editor, key);
      await Promise.resolve();
    }
    return save(editor.children);
  }

  it("a typed property does not grow across saves", async () => {
    const loaded = expectFixedPoint(await typedInto(0, " [k:: v]"));
    expect(firstItem(loaded).properties).toEqual({ k: "v" });
    expect(leadText(loaded)).toBe("lead");
  });

  it("a typed block id survives a second save", async () => {
    const loaded = expectFixedPoint(await typedInto(1, " ^abcdefghij"));
    expect(firstItem(loaded).blockId).toBe("abcdefghij");
    expect(leadText(loaded)).toBe("lead");
  });
});
