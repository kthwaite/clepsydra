import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

const paragraph = (text: string) => ({
  type: "paragraph",
  children: [{ text }],
});
const item = (text: string, checked?: boolean, ...rest: object[]) => ({
  type: "list-item",
  ...(checked === undefined ? {} : { checked }),
  children: [paragraph(text), ...rest],
});
const numbered = (...children: object[]) => ({
  type: "numbered-list",
  children,
});

const tasksIn = (nodes: Descendant[]) =>
  nodes.flatMap((list) =>
    (list as unknown as { children: { checked?: boolean }[] }).children.map(
      (entry) => entry.checked,
    ),
  );

describe("a task in an ordered list right after another ordered list", () => {
  // remark writes the second list with `)`, a marker the GFM task handler skips.
  const adjacent = (second: object) =>
    [numbered(item("a")), numbered(second)] as Descendant[];

  it("keeps a checked box on disk", () => {
    expect(slateToMarkdown(adjacent(item("b", true)))).toBe(
      "1. a\n\n1) [x] b\n",
    );
  });

  it("keeps an unchecked box on disk", () => {
    expect(slateToMarkdown(adjacent(item("b", false)))).toBe(
      "1. a\n\n1) [ ] b\n",
    );
  });

  it("reloads as the same task", () => {
    const doc = adjacent(item("b", true));
    expect(tasksIn(markdownToSlate(slateToMarkdown(doc)))).toEqual([
      undefined,
      true,
    ]);
  });

  it("keeps the box on an empty task", () => {
    const doc = adjacent(item("", false));
    expect(tasksIn(markdownToSlate(slateToMarkdown(doc)))).toEqual([
      undefined,
      false,
    ]);
  });

  it("keeps the box on a task with children", () => {
    const doc = adjacent(
      item("b", true, {
        type: "bulleted-list",
        children: [item("kid")],
      }),
    );
    expect(slateToMarkdown(doc)).toBe("1. a\n\n1) [x] b\n   * kid\n");
  });

  it("does not add a box to a plain item", () => {
    expect(slateToMarkdown(adjacent(item("b")))).toBe("1. a\n\n1) b\n");
  });

  it("does not double the box on a list using the default marker", () => {
    expect(slateToMarkdown([numbered(item("a", true))] as Descendant[])).toBe(
      "1. [x] a\n",
    );
  });
});
