import type { Descendant } from "slate";
import { describe, expect, it } from "vitest";
import { markdownToSlate } from "../index";

const wikilink = (target: string) => ({
  type: "wikilink",
  target,
  children: [{ text: "" }],
});

const firstParagraphChildren = (nodes: Descendant[]): unknown => {
  const [first] = nodes as unknown as {
    type: string;
    children: Descendant[];
  }[];
  return first.type === "paragraph"
    ? first.children
    : firstParagraphChildren(first.children);
};

// The page loads this value as is, and Slate does not normalize an initial value.
// A line ending in an inline void with no text after it gives the caret nowhere
// to go, so typing there is dropped.
describe("inline elements loaded from Markdown", () => {
  it("have text after them at the end of a line", () => {
    expect(firstParagraphChildren(markdownToSlate("see [[Foo]]\n"))).toEqual([
      { text: "see " },
      wikilink("Foo"),
      { text: "" },
    ]);
  });

  it("have text before them at the start of a line", () => {
    expect(firstParagraphChildren(markdownToSlate("[[Foo]] see\n"))).toEqual([
      { text: "" },
      wikilink("Foo"),
      { text: " see" },
    ]);
  });

  it("have text around them in a bullet", () => {
    expect(firstParagraphChildren(markdownToSlate("- [[Foo]]\n"))).toEqual([
      { text: "" },
      wikilink("Foo"),
      { text: "" },
    ]);
  });

  it("have text between two neighbours", () => {
    expect(firstParagraphChildren(markdownToSlate("[[A]][[B]]\n"))).toEqual([
      { text: "" },
      wikilink("A"),
      { text: "" },
      wikilink("B"),
      { text: "" },
    ]);
  });

  it("include ordinary links", () => {
    expect(firstParagraphChildren(markdownToSlate("[a](b)\n"))).toEqual([
      { text: "" },
      { type: "link", url: "b", children: [{ text: "a" }] },
      { text: "" },
    ]);
  });

  it("leave plain text alone", () => {
    expect(firstParagraphChildren(markdownToSlate("plain\n"))).toEqual([
      { text: "plain" },
    ]);
  });
});
