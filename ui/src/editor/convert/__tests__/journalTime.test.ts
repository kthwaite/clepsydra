import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

type Block = {
  type: string;
  level?: number;
  time?: string;
  children: Array<{ text?: string }>;
};

function firstBlock(markdown: string): Block {
  return markdownToSlate(markdown)[0] as Block;
}

describe("journal time heading markdown", () => {
  it.each([
    "00:00",
    "09:07",
    "23:59",
  ])("recognizes an exact level-two %s heading", (time) => {
    expect(firstBlock(`## ${time}`)).toEqual({
      type: "journal-time",
      time,
      children: [{ text: "" }],
    });
  });

  it.each([
    ["# 09:07", 1],
    ["### 09:07", 3],
    ["## 9:07", 2],
    ["## 24:00", 2],
    ["## 12:60", 2],
    ["## 09:07 notes", 2],
    ["## **09:07**", 2],
  ])("keeps %s as an ordinary heading", (markdown, level) => {
    const block = firstBlock(markdown as string);
    expect(block.type).toBe("heading");
    expect(block.level).toBe(level);
  });

  it("does not recognize an unmarked time as a heading", () => {
    expect(firstBlock("09:07").type).toBe("paragraph");
  });

  it("keeps time headings nested in a blockquote as ordinary headings", () => {
    const quote = firstBlock("> ## 09:07") as Block & {
      children: Block[];
    };
    expect(quote.type).toBe("blockquote");
    expect(quote.children[0]).toMatchObject({ type: "heading", level: 2 });
  });

  it("serializes a journal-time element as clean level-two markdown", () => {
    const markdown = slateToMarkdown([
      {
        type: "journal-time",
        time: "09:07",
        children: [{ text: "" }],
      },
    ] as never);
    expect(markdown.trim()).toBe("## 09:07");
  });

  it("round-trips without turning the frozen time back into editable heading text", () => {
    const slate = markdownToSlate(`Before\n\n## 09:07\n\nAfter`);
    const markdown = slateToMarkdown(slate);
    expect(markdown).toContain("## 09:07");
    expect(markdownToSlate(markdown)[1]).toEqual({
      type: "journal-time",
      time: "09:07",
      children: [{ text: "" }],
    });
  });
});
