import type { Element } from "hast";
import { describe, expect, it } from "vitest";
import { mermaidFenceSource } from "#/lib/markdown/mermaidFence";

function fence(language: string | null, value: string): Element {
  return {
    type: "element",
    tagName: "pre",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "code",
        properties: language ? { className: [`language-${language}`] } : {},
        children: [{ type: "text", value }],
      },
    ],
  };
}

describe("mermaidFenceSource", () => {
  it("returns the source of a mermaid fence without its trailing newline", () => {
    expect(mermaidFenceSource(fence("mermaid", "graph TD;\n  a-->b;\n"))).toBe(
      "graph TD;\n  a-->b;",
    );
  });

  it("matches the language case-insensitively", () => {
    expect(mermaidFenceSource(fence("Mermaid", "graph TD;\n"))).toBe(
      "graph TD;",
    );
  });

  it("ignores other languages and unlabelled fences", () => {
    expect(mermaidFenceSource(fence("rust", "fn main() {}\n"))).toBeNull();
    expect(mermaidFenceSource(fence(null, "plain\n"))).toBeNull();
  });

  it("ignores nodes that are not fenced code", () => {
    expect(mermaidFenceSource(undefined)).toBeNull();
    expect(
      mermaidFenceSource({
        type: "element",
        tagName: "div",
        properties: {},
        children: [],
      }),
    ).toBeNull();
  });

  it("reads source split across highlighted spans", () => {
    const node = fence("mermaid", "");
    const code = node.children[0] as Element;
    code.children = [
      { type: "text", value: "graph " },
      {
        type: "element",
        tagName: "span",
        properties: {},
        children: [{ type: "text", value: "TD;" }],
      },
      { type: "text", value: "\n" },
    ];
    expect(mermaidFenceSource(node)).toBe("graph TD;");
  });
});
