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
});
