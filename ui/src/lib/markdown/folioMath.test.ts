import type { Nodes, Root } from "mdast";
import type { InlineMath, Math } from "mdast-util-math";
import { toMarkdown } from "mdast-util-to-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  type FolioMathData,
  folioMathToMarkdown,
  formatMathSource,
  remarkFolioMath,
} from "./folioMath";

type MathNode = (InlineMath | Math) & { data: FolioMathData };

const processor = unified().use(remarkParse).use(remarkFolioMath);

function parse(source: string): Root {
  return processor.runSync(processor.parse(source), { value: source }) as Root;
}

function findMath(tree: Root): MathNode[] {
  const found: MathNode[] = [];

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as { type?: string; children?: unknown[] };
    if (node.type === "math" || node.type === "inlineMath") {
      found.push(node as MathNode);
    }
    node.children?.forEach(visit);
  }

  visit(tree);
  return found;
}

function serialize(root: Root): string {
  return toMarkdown(root as Nodes, {
    extensions: [folioMathToMarkdown()],
  });
}

function inlineNode(value: string, data?: Partial<FolioMathData>): InlineMath {
  return {
    type: "inlineMath",
    value,
    ...(data ? { data } : {}),
  } as InlineMath;
}

function blockNode(value: string, data?: Partial<FolioMathData>): Math {
  return {
    type: "math",
    value,
    ...(data ? { data } : {}),
  } as Math;
}

describe("remarkFolioMath", () => {
  it.each([
    ["inline $x^2$ end", "inlineMath", "$", "x^2"],
    [String.raw`inline \(x^2\) end`, "inlineMath", String.raw`\(`, "x^2"],
    ["$$\nx^2\n$$", "math", "$$", "\nx^2\n"],
    [
      String.raw`\[
x^2
\]`,
      "math",
      String.raw`\[`,
      "\nx^2\n",
    ],
  ])("annotates %s", (source, type, delimiter, body) => {
    const node = findMath(parse(source))[0];

    expect(node).toMatchObject({
      type,
      value: body,
      data: { folioDelimiter: delimiter, folioSourceBody: body },
    });
  });

  it("annotates multiple mixed inline expressions independently", () => {
    const nodes = findMath(parse(String.raw`alpha $x$ and \(y\), then $z^2$.`));

    expect(nodes).toMatchObject([
      {
        type: "inlineMath",
        value: "x",
        data: { folioDelimiter: "$", folioSourceBody: "x" },
      },
      {
        type: "inlineMath",
        value: "y",
        data: { folioDelimiter: String.raw`\(`, folioSourceBody: "y" },
      },
      {
        type: "inlineMath",
        value: "z^2",
        data: { folioDelimiter: "$", folioSourceBody: "z^2" },
      },
    ]);
  });

  it("preserves the exact positioned body of multiline backslash display math", () => {
    const source = String.raw`\[
  \begin{aligned}
  x &= y \\
  z &= 2
  \end{aligned}
\]`;

    expect(findMath(parse(source))[0]).toMatchObject({
      type: "math",
      value:
        "\n  \\begin{aligned}\n  x &= y \\\\\n  z &= 2\n  \\end{aligned}\n",
      data: {
        folioDelimiter: String.raw`\[`,
        folioSourceBody:
          "\n  \\begin{aligned}\n  x &= y \\\\\n  z &= 2\n  \\end{aligned}\n",
      },
    });
  });

  it("does not parse math delimiters in inline code", () => {
    expect(findMath(parse("code: `$x$ and \\(y\\)`"))).toHaveLength(0);
  });

  it("does not parse math delimiters in fenced code", () => {
    const source = ["```tex", "$x$", String.raw`\[y\]`, "```"].join("\n");
    expect(findMath(parse(source))).toHaveLength(0);
  });

  it.each([
    "$x",
    "$$",
    "$$\nx",
    String.raw`\(x`,
    String.raw`\[
x`,
  ])("leaves unmatched delimiters as text: %s", (source) => {
    expect(findMath(parse(source))).toHaveLength(0);
  });

  it("leaves an escaped backslash opener as text", () => {
    expect(findMath(parse(String.raw`escaped \\(not math\)`))).toHaveLength(0);
  });

  it("rejects nested backslash display delimiters", () => {
    const source = String.raw`\[
outer \[
inner
\]
\]`;
    expect(findMath(parse(source))).toHaveLength(0);
  });

  it("rejects trailing content after a backslash display closer", () => {
    const source = String.raw`\[
x
\] trailing`;
    expect(findMath(parse(source))).toHaveLength(0);
  });

  it("preserves paired backslashes inside TeX", () => {
    expect(findMath(parse(String.raw`\(a\\b\)`))[0]).toMatchObject({
      type: "inlineMath",
      value: String.raw`a\\b`,
      data: {
        folioDelimiter: String.raw`\(`,
        folioSourceBody: String.raw`a\\b`,
      },
    });
  });

  it("keeps a dollar preceded by an odd backslash run inside inline math", () => {
    const source = String.raw`$a\$b$`;
    const nodes = findMath(parse(source));

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "inlineMath",
      value: String.raw`a\$b`,
      data: {
        folioDelimiter: "$",
        folioSourceBody: String.raw`a\$b`,
      },
      position: {
        start: { offset: 0 },
        end: { offset: 6 },
      },
    });
  });

  it("treats a dollar preceded by an even backslash run as a closer", () => {
    const nodes = findMath(parse(String.raw`$a\\$b$`));

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "inlineMath",
      value: String.raw`a\\`,
      data: {
        folioDelimiter: "$",
        folioSourceBody: String.raw`a\\`,
      },
      position: {
        start: { offset: 0 },
        end: { offset: 5 },
      },
    });
  });

  it("restores inline double-dollar tokens to text", () => {
    const paragraph = parse("before $$x^2$$ after").children[0];

    expect(findMath(parse("before $$x^2$$ after"))).toHaveLength(0);
    expect(paragraph).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "before " },
        { type: "text", value: "$$x^2$$" },
        { type: "text", value: " after" },
      ],
    });
  });

  it.each([
    ["$x$", "span", "$", "x"],
    [
      String.raw`\[
x
\]`,
      "div",
      String.raw`\[`,
      "\nx\n",
    ],
  ])("projects stable hast data for %s", (source, hName, delimiter, body) => {
    expect(findMath(parse(source))[0]?.data).toMatchObject({
      hName,
      hChildren: [],
      hProperties: {
        "data-folio-math": true,
        "data-tex": body,
        "data-delimiter": delimiter,
      },
    });
  });
});

describe("folioMathToMarkdown", () => {
  it.each([
    ["$x$", "$x$"],
    [String.raw`\(x\)`, String.raw`\(x\)`],
    ["$$\nx\n$$", "$$\nx\n$$"],
    [
      String.raw`\[
x
\]`,
      String.raw`\[
x
\]`,
    ],
  ])("preserves parsed source: %s", (source, expected) => {
    expect(serialize(parse(source)).trim()).toBe(expected.trim());
  });

  it("defaults programmatic inline and display nodes to dollar delimiters", () => {
    const root: Root = {
      type: "root",
      children: [
        { type: "paragraph", children: [inlineNode("x")] },
        blockNode("y"),
      ],
    };

    expect(serialize(root)).toBe("$x$\n\n$$\ny\n$$\n");
  });

  it.each([
    ["a$b", String.raw`\(a$b\)`],
    ["a$$b", "$a$$b$"],
    ["$x", String.raw`\($x\)`],
    ["x$", String.raw`\(x$\)`],
  ])("uses a supported inline delimiter for %s", (body, expected) => {
    const root: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [inlineNode(body)] }],
    };

    expect(serialize(root).trim()).toBe(expected);
    const reparsed = findMath(parse(expected))[0];
    expect(reparsed).toMatchObject({
      type: "inlineMath",
      value: body,
      data: { folioSourceBody: body },
    });
  });

  it("round-trips odd-parity escaped dollars with dollar delimiters", () => {
    const source = String.raw`$a\$b$`;
    const output = serialize(parse(source)).trimEnd();

    expect(output).toBe(source);
    expect(findMath(parse(output))).toMatchObject([
      {
        type: "inlineMath",
        value: String.raw`a\$b`,
        data: {
          folioDelimiter: "$",
          folioSourceBody: String.raw`a\$b`,
        },
      },
    ]);
  });

  it("avoids dollar delimiters for even-parity dollar collisions", () => {
    const body = String.raw`a\\$b`;
    const root: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [inlineNode(body)] }],
    };

    const output = serialize(root).trimEnd();
    expect(output).toBe(String.raw`\(a\\$b\)`);
    expect(findMath(parse(output))).toMatchObject([
      {
        type: "inlineMath",
        value: body,
        data: {
          folioDelimiter: String.raw`\(`,
          folioSourceBody: body,
        },
      },
    ]);
  });

  it.each([
    [String.raw`a\$$b`, String.raw`\(a\$$b\)`, String.raw`\(`],
    [String.raw`a\\$$b`, String.raw`$a\\$$b$`, "$"],
  ])(
    "round-trips a two-dollar streak after escaped-backslash parity: %s",
    (body, expected, delimiter) => {
      const root: Root = {
        type: "root",
        children: [{ type: "paragraph", children: [inlineNode(body)] }],
      };

      const output = serialize(root).trimEnd();
      expect(output).toBe(expected);
      expect(findMath(parse(output))).toMatchObject([
        {
          type: "inlineMath",
          value: body,
          data: {
            folioDelimiter: delimiter,
            folioSourceBody: body,
          },
        },
      ]);
    },
  );

  it("falls back to backslash display syntax on dollar collisions", () => {
    const body = "a $$ b";
    const root: Root = {
      type: "root",
      children: [blockNode(body)],
    };

    const output = serialize(root).trim();
    expect(output).toBe(String.raw`\[a $$ b\]`);
    expect(findMath(parse(output))[0]).toMatchObject({
      type: "math",
      value: body,
      data: {
        folioDelimiter: String.raw`\[`,
        folioSourceBody: body,
      },
    });
  });

  it.each([
    ["$ x $", " x "],
    ["before $ a\nb $ after", " a\nb "],
    ["before $ a\r\nb $ after", " a\r\nb "],
  ])(
    "preserves authored inline source and line endings: %s",
    (source, body) => {
      const output = serialize(parse(source)).trimEnd();
      expect(output).toBe(source);
      expect(findMath(parse(output))[0]).toMatchObject({
        type: "inlineMath",
        value: body,
        data: { folioDelimiter: "$", folioSourceBody: body },
      });
    },
  );

  it("preserves an authored display body containing dollar streaks", () => {
    const source = "$$\na $$ b\n$$";
    const output = serialize(parse(source)).trimEnd();

    expect(output).toBe(source);
    expect(findMath(parse(output))[0]).toMatchObject({
      type: "math",
      value: "\na $$ b\n",
      data: { folioDelimiter: "$$", folioSourceBody: "\na $$ b\n" },
    });
  });
});

describe("formatMathSource", () => {
  it.each([
    ["x", "$", "$x$"],
    ["x", "\\(", String.raw`\(x\)`],
    ["\nx\n", "$$", "$$\nx\n$$"],
    [
      "\nx\n",
      "\\[",
      String.raw`\[
x
\]`,
    ],
  ] as const)("pairs %s with %s", (body, delimiter, expected) => {
    expect(formatMathSource(body, delimiter)).toBe(expected);
  });
});
