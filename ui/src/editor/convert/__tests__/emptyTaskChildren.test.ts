import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

const paragraph = (text: string) =>
  ({ type: "paragraph", children: [{ text }] }) as Descendant;
const item = (text: string, ...rest: Descendant[]) =>
  ({ type: "list-item", children: [paragraph(text), ...rest] }) as Descendant;
const task = (checked: boolean, text: string, ...rest: Descendant[]) =>
  ({
    type: "list-item",
    checked,
    children: [paragraph(text), ...rest],
  }) as Descendant;
const list = (...children: Descendant[]) =>
  ({ type: "bulleted-list", children }) as Descendant;

describe("an empty task with children", () => {
  it("writes one checkbox, on the marker's line", () => {
    const md = slateToMarkdown([list(task(false, "", list(item("kid"))))]);

    expect(md).toBe("* [ ] \n  * kid\n");
  });

  it.each([[false], [true]])("reloads unchanged when checked=%s", (checked) => {
    const doc = [list(task(checked, "", list(item("kid"))))];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual(doc);
  });

  it("works in a numbered list", () => {
    const doc = [
      {
        type: "numbered-list",
        children: [task(false, "", list(item("kid")))],
      } as Descendant,
    ];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual(doc);
  });

  it("keeps a following sibling a separate item", () => {
    const doc = [list(task(false, "", list(item("kid"))), item("next"))];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual(doc);
  });

  it("leaves a task with text unchanged", () => {
    const doc = [list(task(false, "text", list(item("kid"))))];

    expect(slateToMarkdown(doc)).toBe("* [ ] text\n  * kid\n");
    expect(markdownToSlate(slateToMarkdown(doc))).toEqual(doc);
  });

  it("keeps a code block after an empty task", () => {
    const doc = [
      list(
        task(false, "", {
          type: "code-block",
          children: [{ text: "code" }],
        } as Descendant),
      ),
    ];

    expect(markdownToSlate(slateToMarkdown(doc))).toEqual(doc);
  });
});
