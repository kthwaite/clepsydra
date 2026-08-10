import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../index";

function normalize(md: string): string {
  return md.trim().replace(/\n{3,}/g, "\n\n");
}

function roundTrip(input: string): string {
  const slate = markdownToSlate(input);
  return slateToMarkdown(slate);
}

describe("round-trip: markdown → slate → markdown", () => {
  it("preserves a simple paragraph", () => {
    const input = "Hello world";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves headings", () => {
    const input = "# Heading 1\n\n## Heading 2";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves inline formatting (bold, italic, code)", () => {
    const input = "Some **bold** and *italic* and `code` text";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves code blocks with language", () => {
    const input = "```typescript\nconst x: number = 1;\nconsole.log(x);\n```";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves code blocks without language", () => {
    const input = "```\nhello world\n```";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves blockquotes", () => {
    const input = "> A quoted paragraph";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves links", () => {
    const input = "Visit [Example](https://example.com) for more";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves CAS-backed images with alt text and title", () => {
    const input =
      'Before ![Archived chart](cas:sha256:abc123 "Quarterly chart") after';
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves thematic breaks", () => {
    const input = "Above\n\n---\n\nBelow";
    // The serializer uses `---` for thematic breaks (rule: "-")
    const result = normalize(roundTrip(input));
    expect(result).toContain("Above");
    expect(result).toContain("---");
    expect(result).toContain("Below");
  });

  it("preserves wikilinks without alias", () => {
    const input = "See [[My Page]] for details";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves wikilinks with alias", () => {
    const input = "See [[My Page|display text]] for details";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves bulleted lists", () => {
    const input = "* Item 1\n* Item 2\n* Item 3";
    const result = normalize(roundTrip(input));
    // The serializer uses `*` for bullets
    expect(result).toContain("* Item 1");
    expect(result).toContain("* Item 2");
    expect(result).toContain("* Item 3");
  });

  it("preserves ordered lists", () => {
    const input = "1. First\n2. Second\n3. Third";
    const result = normalize(roundTrip(input));
    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect(result).toContain("Third");
    // Verify ordering markers are present
    expect(result).toMatch(/1\.\s+First/);
    expect(result).toMatch(/2\.\s+Second/);
    expect(result).toMatch(/3\.\s+Third/);
  });

  it("preserves block references", () => {
    const input = "See ((abc123DEF0a)) for details";
    const result = normalize(roundTrip(input));
    expect(result).toContain("((abc123DEF0a))");
  });

  it("preserves a complex mixed document", () => {
    const input = `# Title

A paragraph with **bold** and *italic* words.

> A blockquote

* Item one
* Item two

\`\`\`js
console.log("hi");
\`\`\`

---

See [[Other Page]] for more.`;

    const result = normalize(roundTrip(input));

    expect(result).toContain("# Title");
    expect(result).toContain("**bold**");
    expect(result).toContain("*italic*");
    expect(result).toContain("> A blockquote");
    expect(result).toContain("* Item one");
    expect(result).toContain("* Item two");
    expect(result).toContain("```js");
    expect(result).toContain('console.log("hi");');
    expect(result).toContain("```");
    expect(result).toContain("---");
    expect(result).toContain("[[Other Page]]");
  });

  it("preserves strikethrough", () => {
    const input = "Some ~deleted~ text";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("preserves superscript and subscript as inline <sup>/<sub> HTML", () => {
    const input = "x<sup>2</sup> and H<sub>2</sub>O";
    const result = roundTrip(input);
    expect(result).toContain("<sup>2</sup>");
    expect(result).toContain("<sub>2</sub>");
  });

  it("preserves underline as inline <u> HTML", () => {
    const input = "Some <u>underlined</u> text";
    const result = normalize(roundTrip(input));
    expect(result).toContain("<u>");
    expect(result).toContain("underlined");
    expect(result).toContain("</u>");
  });

  it("round-trips an underline mark added in slate", () => {
    // Simulate what the editor produces when Cmd+U is pressed: a CustomText
    // with `underline: true`. Slate → md → slate must preserve the mark.
    const slate = [
      {
        type: "paragraph",
        children: [
          { text: "before " },
          { text: "marked", underline: true },
          { text: " after" },
        ],
      },
    ] as Parameters<typeof slateToMarkdown>[0];
    const md = slateToMarkdown(slate);
    expect(md).toContain("<u>");
    expect(md).toContain("marked");
    expect(md).toContain("</u>");

    const back = markdownToSlate(md);
    const para = back[0] as { children: { text: string; underline?: true }[] };
    const marked = para.children.find((c) => c.text === "marked");
    expect(marked?.underline).toBe(true);
  });

  it("round-trips slate paragraph with underline-only text node", () => {
    // The simplest case: a paragraph whose entire content is a single
    // underlined text node. slate → md → slate must preserve text + mark.
    const slate = [
      {
        type: "paragraph",
        children: [{ text: "foo", underline: true }],
      },
    ] as Parameters<typeof slateToMarkdown>[0];

    const md = slateToMarkdown(slate);
    expect(md).toContain("<u>");
    expect(md).toContain("foo");
    expect(md).toContain("</u>");

    const back = markdownToSlate(md);
    const para = back[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para.type).toBe("paragraph");
    // Find the text node carrying "foo" — it must still have underline:true.
    const fooNode = para.children.find((c) => c.text === "foo");
    expect(fooNode).toBeDefined();
    expect(fooNode?.underline).toBe(true);
  });

  it("round-trips markdown <u>foo</u> as a line on its own", () => {
    // Markdown → Slate → markdown → Slate. A bare `<u>foo</u>` line is parsed
    // by remark as inline html inside a paragraph, but the content must be
    // preserved with the underline mark across the round trip.
    const input = "<u>foo</u>";

    const slate1 = markdownToSlate(input);
    const para1 = slate1[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para1.type).toBe("paragraph");
    const foo1 = para1.children.find((c) => c.text === "foo");
    expect(foo1).toBeDefined();
    expect(foo1?.underline).toBe(true);

    const md = slateToMarkdown(slate1);
    expect(md).toContain("<u>");
    expect(md).toContain("foo");
    expect(md).toContain("</u>");

    const slate2 = markdownToSlate(md);
    const para2 = slate2[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para2.type).toBe("paragraph");
    const foo2 = para2.children.find((c) => c.text === "foo");
    expect(foo2?.underline).toBe(true);
  });

  it("round-trips markdown <u>foo</u> emitted as a block-level html node", () => {
    // When the opening tag is on a line by itself, remark/micromark emits a
    // top-level `html` node (HTML block type 7) instead of an inline-html
    // pair inside a paragraph. The mdast-to-slate converter must still
    // surface the content with the underline mark; it used to be dropped.
    const input = "<u>\nfoo\n</u>";

    const slate1 = markdownToSlate(input);
    expect(slate1.length).toBeGreaterThan(0);
    const para1 = slate1[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para1.type).toBe("paragraph");
    // The inner text may include surrounding newlines; just check it contains
    // "foo" and that the carrier text node has underline:true.
    const underlined = para1.children.find((c) => c.underline === true);
    expect(underlined).toBeDefined();
    expect(underlined?.text).toContain("foo");

    const md = slateToMarkdown(slate1);
    expect(md).toContain("<u>");
    expect(md).toContain("foo");
    expect(md).toContain("</u>");

    const slate2 = markdownToSlate(md);
    const para2 = slate2[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para2.type).toBe("paragraph");
    const underlined2 = para2.children.find((c) => c.underline === true);
    expect(underlined2).toBeDefined();
    expect(underlined2?.text).toContain("foo");
  });

  it("round-trips inline <u>mid</u> within a paragraph", () => {
    // Locks in the inline path: surrounding plain text plus an underlined
    // segment. Markdown → Slate → markdown → Slate must keep all three runs
    // and the underline mark on the middle run.
    const input = "before <u>mid</u> after";

    const slate1 = markdownToSlate(input);
    const para1 = slate1[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para1.type).toBe("paragraph");
    const mid1 = para1.children.find((c) => c.text === "mid");
    expect(mid1?.underline).toBe(true);
    expect(
      para1.children.some((c) => c.text === "before " && !c.underline),
    ).toBe(true);
    expect(
      para1.children.some((c) => c.text === " after" && !c.underline),
    ).toBe(true);

    const md = slateToMarkdown(slate1);
    expect(md).toContain("before");
    expect(md).toContain("<u>");
    expect(md).toContain("mid");
    expect(md).toContain("</u>");
    expect(md).toContain("after");

    const slate2 = markdownToSlate(md);
    const para2 = slate2[0] as {
      type: string;
      children: { text: string; underline?: true }[];
    };
    expect(para2.type).toBe("paragraph");
    const mid2 = para2.children.find((c) => c.text === "mid");
    expect(mid2?.underline).toBe(true);
  });

  it.each([
    "$x$",
    String.raw`\(x\)`,
    "$$\nx\n$$",
    String.raw`\[
x
\]`,
  ])("preserves math source: %s", (source) => {
    expect(slateToMarkdown(markdownToSlate(source)).trim()).toBe(source.trim());
  });


  it("round-trips programmatic inline dollar collisions through backslash math", () => {
    const slate = [
      {
        type: "paragraph",
        children: [
          {
            type: "inline-math",
            tex: "a$b",
            delimiter: "$",
            children: [{ text: "" }],
          },
        ],
      },
    ] as Parameters<typeof slateToMarkdown>[0];

    const markdown = slateToMarkdown(slate).trim();
    expect(markdown).toBe(String.raw`\(a$b\)`);
    expect(markdownToSlate(markdown)).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "inline-math",
            tex: "a$b",
            delimiter: String.raw`\(`,
            children: [{ text: "" }],
          },
        ],
      },
    ]);
  });

  it("round-trips programmatic display dollar collisions through backslash math", () => {
    const slate = [
      {
        type: "math-block",
        tex: "a $$ b",
        delimiter: "$$",
        children: [{ text: "" }],
      },
    ] as Parameters<typeof slateToMarkdown>[0];

    const markdown = slateToMarkdown(slate).trim();
    expect(markdown).toBe(String.raw`\[a $$ b\]`);
    expect(markdownToSlate(markdown)).toEqual([
      {
        type: "math-block",
        tex: "a $$ b",
        delimiter: String.raw`\[`,
        children: [{ text: "" }],
      },
    ]);
  });
  it("keeps surrounding paragraphs and code blocks unchanged", () => {
    const source = [
      "before $x$ after",
      "",
      "```tex",
      String.raw`\(not-math\)`,
      "$not-math$",
      "```",
    ].join("\n");

    expect(roundTrip(source).trim()).toBe(source);
  });
});

describe("footnotes round-trip", () => {
  it("parses a footnote reference into an inline footnote-ref and a footnote-def block", () => {
    const slate = markdownToSlate("A claim.[^1]\n\n[^1]: The source.\n");
    const json = JSON.stringify(slate);
    expect(json).toContain('"type":"footnote-ref"');
    expect(json).toContain('"identifier":"1"');
    expect(json).toContain('"type":"footnote-def"');
  });

  it("round-trips a footnote ref + definition without dropping it", () => {
    const md = "A claim.[^1]\n\n[^1]: The source.\n";
    const back = slateToMarkdown(markdownToSlate(md));
    expect(back).toContain("[^1]");
    expect(back).toContain("[^1]: The source.");
  });
});
