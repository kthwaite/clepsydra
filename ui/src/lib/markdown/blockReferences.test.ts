import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  BLOCK_REFERENCE_SCHEME,
  blockIdFromHref,
  remarkBlockReferences,
} from "./blockReferences";

function parseAndTransform(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkBlockReferences);
  return processor.runSync(processor.parse(markdown)) as Root;
}

function findPrivateBlockLinks(tree: Root): Nodes[] {
  const links: Nodes[] = [];

  function visit(node: Nodes): void {
    if (
      node.type === "link" &&
      node.url.startsWith(BLOCK_REFERENCE_SCHEME)
    ) {
      links.push(node);
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }

  visit(tree);
  return links;
}

describe("remarkBlockReferences", () => {
  it("turns standalone text references into private links", () => {
    const tree = parseAndTransform("Before ((abc123DEF0)) after");

    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "Before " },
        {
          type: "link",
          url: "clepsydra-block:abc123DEF0",
          children: [{ type: "text", value: "((abc123DEF0))" }],
        },
        { type: "text", value: " after" },
      ],
    });
  });

  it("transforms adjacent references without dropping either match", () => {
    const tree = parseAndTransform("((abc123DEF0))((abc123DEF045))");

    expect(findPrivateBlockLinks(tree)).toMatchObject([
      {
        type: "link",
        url: "clepsydra-block:abc123DEF0",
      },
      {
        type: "link",
        url: "clepsydra-block:abc123DEF045",
      },
    ]);
  });

  it("transforms every valid reference inside nested phrasing content", () => {
    const tree = parseAndTransform(
      "**First ((abc123DEF0)), second ((abc123DEF045)).**",
    );

    expect(findPrivateBlockLinks(tree)).toMatchObject([
      {
        type: "link",
        url: "clepsydra-block:abc123DEF0",
        children: [{ type: "text", value: "((abc123DEF0))" }],
      },
      {
        type: "link",
        url: "clepsydra-block:abc123DEF045",
        children: [{ type: "text", value: "((abc123DEF045))" }],
      },
    ]);
  });

  it("preserves ordinary parentheses and invalid block reference forms", () => {
    const source =
      "Keep (ordinary), ((abc123DE0)), ((abc123DEF0456)), and ((abc123_DEF)).";
    const tree = parseAndTransform(source);

    expect(findPrivateBlockLinks(tree)).toHaveLength(0);
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: source }],
    });
  });

  it("leaves code and existing link labels untouched", () => {
    const tree = parseAndTransform(
      [
        "`((abc123DEF0))` [((abc123DEF0))](x.md) [((abc123DEF0))][ref]",
        "",
        "```md",
        "((abc123DEF0))",
        "```",
        "",
        "[ref]: y.md",
      ].join("\n"),
    );

    expect(findPrivateBlockLinks(tree)).toHaveLength(0);
  });

  it("does not descend into HTML or MDX nodes", () => {
    const htmlTree = parseAndTransform(
      '<div data-value="((abc123DEF0))">\n((abc123DEF0))\n</div>',
    );
    expect(findPrivateBlockLinks(htmlTree)).toHaveLength(0);

    const mdxTree = {
      type: "root",
      children: [
        {
          type: "mdxJsxTextElement",
          children: [{ type: "text", value: "((abc123DEF0))" }],
        },
      ],
    };
    remarkBlockReferences()(mdxTree as unknown as Root);
    expect(mdxTree.children[0].children).toEqual([
      { type: "text", value: "((abc123DEF0))" },
    ]);
  });
});

describe("blockIdFromHref", () => {
  it("accepts only private hrefs containing a valid block ID", () => {
    expect(blockIdFromHref("clepsydra-block:abc123DEF0")).toBe("abc123DEF0");
    expect(blockIdFromHref("clepsydra-block:abc123DEF045")).toBe(
      "abc123DEF045",
    );
    expect(blockIdFromHref("https://example.test/abc123DEF0")).toBeNull();
    expect(blockIdFromHref("clepsydra-block:abc123DE0")).toBeNull();
    expect(blockIdFromHref("clepsydra-block:abc123DEF0456")).toBeNull();
    expect(blockIdFromHref("clepsydra-block:abc123_DEF")).toBeNull();
  });
});
