import { Editor, Transforms } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../convert";
import { makeEditor, outline } from "./harness";
import { indentListItem } from "../plugins/withOutliner";

const fromMd = (md: string) => makeEditor(markdownToSlate(md));
const toMd = (e: Editor) => slateToMarkdown(e.children);
const reloadView = (e: Editor) =>
  outline(makeEditor(markdownToSlate(toMd(e)))).map((l) => `${l.depth}${l.kind}:${l.text}`);

describe("from real edit sequences", () => {
  it("C12: parent, Enter, Tab, then save keeps an empty child bullet", () => {
    const e = fromMd("- parent\n");
    Transforms.select(e, Editor.end(e, [0, 0, 0]));
    Editor.insertBreak(e);
    indentListItem(e);
    expect(reloadView(e)).toEqual(["1b:parent", "2b:"]);
  });

  it("C11: deleting all of a bold bullet's text, then save keeps the bullet", () => {
    const e = fromMd("- **x**\n- y\n");
    Transforms.select(e, Editor.end(e, [0, 0, 0]));
    Editor.deleteBackward(e, { unit: "character" });
    expect(reloadView(e)).toEqual(["1b:", "1b:y"]);
  });

  it("C13: Enter in a blockquote inside a bullet stays in the quote", () => {
    const e = fromMd("- a\n\n  > quote\n\n  - kid\n");
    const quote = outline(e).find((l) => l.text === "quote");
    if (!quote) throw new Error("no quote");
    Transforms.select(e, Editor.start(e, quote.path));
    Transforms.move(e, { distance: 2, unit: "offset" });
    Editor.insertBreak(e);
    expect(outline(e).map((l) => l.text)).toEqual(["a", "qu", "ote", "kid"]);
    expect(toMd(e)).toContain(">");
  });
});
