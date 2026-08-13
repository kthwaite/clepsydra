import {
  createEditor,
  type Descendant,
  Editor,
  Node,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMdast } from "../../../convert/slate-to-mdast";
import { withSchema } from "../../../schema/withSchema";
import { withOutliner } from "../../withOutliner";
import { withAutoformat } from "../withAutoformat";

function makeEditor(value?: any[]) {
  const editor = withAutoformat(withOutliner(withHistory(createEditor())));
  editor.children = value ?? [{ type: "paragraph", children: [{ text: "" }] }];
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  });
  return editor;
}

// Schema-aware editor mirrors the real SlateEditor composition so that inline
// elements (links) get isInline. Used for the IME/dead-key composition tests.
function makeSchemaEditor(value?: Descendant[]) {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = value ?? [{ type: "paragraph", children: [{ text: "" }] }];
  Transforms.select(editor, Editor.end(editor, [0]));
  return editor;
}

function type(editor: Editor, text: string) {
  for (const ch of text) {
    editor.insertText(ch);
  }
}

function elementChildren(node: Descendant): Descendant[] {
  if (!SlateElement.isElement(node)) {
    throw new Error("Expected an element node");
  }
  return node.children;
}

function isFootnoteDefinition(node: Descendant, identifier?: string): boolean {
  return (
    SlateElement.isElement(node) &&
    node.type === "footnote-def" &&
    (identifier === undefined || node.identifier === identifier)
  );
}

describe("withAutoformat integration", () => {
  describe("block transforms via insertText", () => {
    it("# + space converts to heading 1", () => {
      const editor = makeEditor();
      type(editor, "# ");
      expect((editor.children[0] as any).type).toBe("heading");
      expect((editor.children[0] as any).level).toBe(1);
    });

    it("- + space converts to bulleted list", () => {
      const editor = makeEditor();
      type(editor, "- ");
      const firstChild = editor.children[0] as any;
      expect(firstChild.type).toBe("bulleted-list");
    });

    it("--- converts to thematic break", () => {
      const editor = makeEditor();
      type(editor, "---");
      expect((editor.children[0] as any).type).toBe("thematic-break");
    });

    it("> + space converts to blockquote", () => {
      const editor = makeEditor();
      type(editor, "> ");
      expect((editor.children[0] as any).type).toBe("blockquote");
    });

    it("1. + space converts to numbered list", () => {
      const editor = makeEditor();
      type(editor, "1. ");
      expect((editor.children[0] as any).type).toBe("numbered-list");
    });
  });

  describe("typed math", () => {
    it("converts typed dollar syntax and selects the text after the inline void", () => {
      const editor = makeSchemaEditor();

      editor.insertText("$");
      editor.insertText("x");
      editor.insertText("$");

      expect(elementChildren(editor.children[0])).toEqual([
        { text: "" },
        {
          type: "inline-math",
          tex: "x",
          delimiter: "$",
          children: [{ text: "" }],
        },
        { text: "" },
      ]);
      expect(editor.selection).toEqual({
        anchor: { path: [0, 2], offset: 0 },
        focus: { path: [0, 2], offset: 0 },
      });
    });

    it("converts typed backslash-parenthesis syntax", () => {
      const editor = makeSchemaEditor();

      type(editor, String.raw`\(x\)`);

      expect(elementChildren(editor.children[0])).toContainEqual(
        expect.objectContaining({
          type: "inline-math",
          tex: "x",
          delimiter: "\\(",
        }),
      );
    });

    it("converts a backslash-parenthesis closer consumed by overtype", () => {
      const editor = makeSchemaEditor([
        {
          type: "paragraph",
          children: [{ text: String.raw`\(x\)` }],
        },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: 4 });

      editor.insertText(")");

      expect(elementChildren(editor.children[0])).toEqual([
        { text: "" },
        {
          type: "inline-math",
          tex: "x",
          delimiter: "\\(",
          children: [{ text: "" }],
        },
        { text: "" },
      ]);
      expect(editor.selection).toEqual({
        anchor: { path: [0, 2], offset: 0 },
        focus: { path: [0, 2], offset: 0 },
      });
    });

    it.each([
      ["$$x$$", "$$", "x"],
      [String.raw`\[x\]`, "\\[", "x"],
    ])(
      "converts standalone display syntax %s and selects a following paragraph",
      (source, delimiter, tex) => {
        const editor = makeSchemaEditor();

        type(editor, source);

        expect(editor.children).toEqual([
          {
            type: "math-block",
            tex,
            delimiter,
            children: [{ text: "" }],
          },
          { type: "paragraph", children: [{ text: "" }] },
        ]);
        expect(editor.selection).toEqual({
          anchor: { path: [1, 0], offset: 0 },
          focus: { path: [1, 0], offset: 0 },
        });
      },
    );

    it.each([
      ["$$", "$$", "$$"],
      [String.raw`\[`, "\\[", String.raw`\]`],
    ])(
      "keeps Enter literal inside an unmatched %s display and converts multiline source",
      (opener, delimiter, closer) => {
        const editor = makeSchemaEditor();

        type(editor, `${opener}first`);
        editor.insertBreak();
        type(editor, `second${closer}`);

        expect(editor.children).toEqual([
          {
            type: "math-block",
            tex: "first\nsecond",
            delimiter,
            children: [{ text: "" }],
          },
          { type: "paragraph", children: [{ text: "" }] },
        ]);
        expect(editor.selection).toEqual({
          anchor: { path: [1, 0], offset: 0 },
          focus: { path: [1, 0], offset: 0 },
        });
      },
    );

    it.each([
      [
        "blockquote",
        "$$nested$$",
        "$$",
        [
          {
            type: "blockquote",
            children: [{ type: "paragraph", children: [{ text: "" }] }],
          },
        ],
        [0],
        [0, 1, 0],
      ],
      [
        "blockquote",
        String.raw`\[nested\]`,
        "\\[",
        [
          {
            type: "blockquote",
            children: [{ type: "paragraph", children: [{ text: "" }] }],
          },
        ],
        [0],
        [0, 1, 0],
      ],
      [
        "list item",
        "$$nested$$",
        "$$",
        [
          {
            type: "bulleted-list",
            children: [
              {
                type: "list-item",
                children: [{ type: "paragraph", children: [{ text: "" }] }],
              },
            ],
          },
        ],
        [0, 0],
        [0, 0, 1, 0],
      ],
      [
        "list item",
        String.raw`\[nested\]`,
        "\\[",
        [
          {
            type: "bulleted-list",
            children: [
              {
                type: "list-item",
                children: [{ type: "paragraph", children: [{ text: "" }] }],
              },
            ],
          },
        ],
        [0, 0],
        [0, 0, 1, 0],
      ],
    ])(
      "converts standalone %s display source %s at its nested paragraph path",
      (_containerName, source, delimiter, value, containerPath, caretPath) => {
        const editor = makeSchemaEditor(value as Descendant[]);

        type(editor, source);

        const [container] = Editor.node(editor, containerPath);
        if (!SlateElement.isElement(container)) {
          throw new Error("Expected a nested display container");
        }
        expect(container.children).toEqual([
          {
            type: "math-block",
            tex: "nested",
            delimiter,
            children: [{ text: "" }],
          },
          { type: "paragraph", children: [{ text: "" }] },
        ]);
        expect(editor.selection).toEqual({
          anchor: { path: caretPath, offset: 0 },
          focus: { path: caretPath, offset: 0 },
        });
      },
    );

    it.each(["before $$x$$", String.raw`before \[x\]`])(
      "leaves non-standalone display syntax as text: %s",
      (source) => {
        const editor = makeSchemaEditor();

        type(editor, source);

        expect(Node.string(editor.children[0])).toBe(source);
        expect(
          elementChildren(editor.children[0]).some(
            (child) =>
              SlateElement.isElement(child) &&
              (child.type === "inline-math" || child.type === "math-block"),
          ),
        ).toBe(false);
      },
    );

    it("leaves unsupported longer display-dollar fences as text", () => {
      const editor = makeSchemaEditor();

      type(editor, "$$$x$$");

      expect(Node.string(editor.children[0])).toBe("$$$x$$");
      expect(
        elementChildren(editor.children[0]).some((child) =>
          SlateElement.isElement(child),
        ),
      ).toBe(false);
    });

    it.each([
      ["$[x]$", "inline-math", "$", "[x]"],
      [String.raw`\([x]\)`, "inline-math", "\\(", "[x]"],
      ["$$[x]$$", "math-block", "$$", "[x]"],
      [String.raw`\[[x]\]`, "math-block", "\\[", "[x]"],
    ])(
      "keeps bracket groups literal inside typed math source: %s",
      (source, elementType, delimiter, tex) => {
        const editor = makeSchemaEditor();

        type(editor, source);

        const math = editor.children
          .flatMap((node) =>
            SlateElement.isElement(node) ? node.children : [],
          )
          .find(
            (child) =>
              SlateElement.isElement(child) && child.type === elementType,
          );
        const block =
          SlateElement.isElement(editor.children[0]) &&
          editor.children[0].type === elementType
            ? editor.children[0]
            : math;
        expect(block).toMatchObject({ type: elementType, delimiter, tex });
      },
    );

    it.each([
      ["$*x*$", "*x*"],
      ["$_x_$", "_x_"],
      ["$ *x$", " *x"],
    ])(
      "keeps mark syntax literal inside typed math source: %s",
      (source, tex) => {
        const editor = makeSchemaEditor();

        type(editor, source);

        expect(elementChildren(editor.children[0])).toContainEqual(
          expect.objectContaining({
            type: "inline-math",
            delimiter: "$",
            tex,
          }),
        );
      },
    );

    it("overtypes a bracket inside an unmatched math candidate literally", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "$[x]" }] },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: 3 });

      editor.insertText("]");

      expect(Node.string(editor.children[0])).toBe("$[x]");
      expect(editor.selection).toEqual({
        anchor: { path: [0, 0], offset: 4 },
        focus: { path: [0, 0], offset: 4 },
      });
    });

    it.each(["$[x]", "$*x*"])(
      "keeps generic Markdown syntax literal in an unmatched composed math candidate: %s",
      (source) => {
        const editor = makeSchemaEditor();

        editor.insertText(source);

        expect(Node.string(editor.children[0])).toBe(source);
        expect(
          elementChildren(editor.children[0]).some((child) =>
            SlateElement.isElement(child),
          ),
        ).toBe(false);
      },
    );

    it.each(["$x", String.raw`\(x`, "$$x", String.raw`\[x`])(
      "leaves unmatched math syntax as text: %s",
      (source) => {
        const editor = makeSchemaEditor();

        type(editor, source);

        expect(Node.string(editor.children[0])).toBe(source);
      },
    );

    it.each(["$$", String.raw`\(\)`, "$$$$", String.raw`\[\]`])(
      "leaves empty math syntax as text: %s",
      (source) => {
        const editor = makeSchemaEditor();

        type(editor, source);

        expect(Node.string(editor.children[0])).toBe(source);
      },
    );

    it("does not convert math syntax in a code leaf", () => {
      const editor = makeSchemaEditor([
        {
          type: "paragraph",
          children: [{ text: "", code: true }],
        },
      ]);

      type(editor, String.raw`$x$ \(y\)`);

      expect(Node.string(editor.children[0])).toBe(String.raw`$x$ \(y\)`);
      expect(
        elementChildren(editor.children[0]).some((child) =>
          SlateElement.isElement(child),
        ),
      ).toBe(false);
    });

    it("does not convert math syntax in a code block", () => {
      const editor = makeSchemaEditor([
        {
          type: "code-block",
          language: "",
          children: [{ text: "" }],
        },
      ]);

      type(editor, String.raw`$x$ \(y\) $$z$$ \[w\]`);

      expect(Node.string(editor.children[0])).toBe(
        String.raw`$x$ \(y\) $$z$$ \[w\]`,
      );
      expect(editor.children[0]).toMatchObject({ type: "code-block" });
    });

    it("resolves multiple math expressions in one composed insertion", () => {
      const editor = makeSchemaEditor();

      editor.insertText(String.raw`$x$ and \(y\)`);

      expect(elementChildren(editor.children[0])).toEqual([
        { text: "" },
        expect.objectContaining({
          type: "inline-math",
          tex: "x",
          delimiter: "$",
        }),
        { text: " and " },
        expect.objectContaining({
          type: "inline-math",
          tex: "y",
          delimiter: "\\(",
        }),
        { text: "" },
      ]);
      expect(editor.selection).toEqual({
        anchor: { path: [0, 4], offset: 0 },
        focus: { path: [0, 4], offset: 0 },
      });
    });

    it("resolves math before a later link scaffold in one composed insertion", () => {
      const editor = makeSchemaEditor();

      editor.insertText("$x$ and [label]");

      const children = elementChildren(editor.children[0]);
      expect(children).toEqual([
        { text: "" },
        expect.objectContaining({
          type: "inline-math",
          tex: "x",
          delimiter: "$",
        }),
        { text: " and [label]()" },
      ]);
      const selection = editor.selection;
      expect(selection).not.toBeNull();
      if (!selection) throw new Error("Expected a composed endpoint selection");
      const [selected] = Editor.node(editor, selection.anchor.path);
      expect(Text.isText(selected) ? selected.text : null).toBe(
        " and [label]()",
      );
      expect(selection).toEqual({
        anchor: { path: [0, 2], offset: " and [label](".length },
        focus: { path: [0, 2], offset: " and [label](".length },
      });
    });

    it.each([
      ["$$x$$", "$$"],
      [String.raw`\[x\]`, "\\["],
    ])(
      "resolves composed standalone display syntax %s",
      (source, delimiter) => {
        const editor = makeSchemaEditor();

        editor.insertText(source);

        expect(editor.children[0]).toMatchObject({
          type: "math-block",
          tex: "x",
          delimiter,
        });
        expect(editor.selection?.anchor.path).toEqual([1, 0]);
      },
    );
  });

  describe("inline transforms via insertText", () => {
    it("*text* applies italic", () => {
      const editor = makeEditor();
      type(editor, "*hello*");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(leaves.some((l: any) => l.italic && l.text === "hello")).toBe(
        true,
      );
    });

    it("~text~ applies strikethrough", () => {
      const editor = makeEditor();
      type(editor, "~hello~");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(
        leaves.some((l: any) => l.strikethrough && l.text === "hello"),
      ).toBe(true);
    });

    it("keeps strikethrough literal until the closing ~ is typed", () => {
      const editor = makeEditor();
      type(editor, "~hello");
      const para = editor.children[0] as any;
      expect(Node.string(para)).toBe("~hello");
      expect(para.children.some((leaf: any) => leaf.strikethrough)).toBe(false);
    });

    it("`text` applies code mark", () => {
      const editor = makeEditor();
      type(editor, "`code`");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(leaves.some((l: any) => l.code && l.text === "code")).toBe(true);
    });

    it("converts a typed labeled wikilink into a wikilink element", () => {
      const editor = makeSchemaEditor();
      type(editor, "[[My Page|display text]]");

      const children = elementChildren(editor.children[0]);
      expect(children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "wikilink",
            target: "My Page",
            alias: "display text",
          }),
        ]),
      );
    });

    it("`text` inside parentheses applies code mark", () => {
      const editor = makeEditor();
      type(editor, "(`foo bar`");
      const para = editor.children[0] as any;
      const leaves = para.children;
      expect(leaves.some((l: any) => l.code && l.text === "foo bar")).toBe(
        true,
      );
      expect(leaves.some((l: any) => l.text.includes("("))).toBe(true);
    });

    it("] after [label inserts () and places the caret inside", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");

      expect(Node.string(editor.children[0])).toBe("[Example]()");
      expect(editor.selection).toEqual({
        anchor: { path: [0, 0], offset: "[Example](".length },
        focus: { path: [0, 0], offset: "[Example](".length },
      });
    });

    it("overtype-closing the inserted ) creates a link without storing the closer", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");
      type(editor, "https://example.com)");

      const children = (editor.children[0] as any).children;
      const link = children.find((child: any) => child.type === "link");
      expect(link).toMatchObject({
        type: "link",
        url: "https://example.com",
        children: [{ text: "Example" }],
      });
      expect(Node.string(editor.children[0])).toBe("Example");
    });

    it("continues typing after a completed link in sibling plain text", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");
      type(editor, "https://example.com)");
      type(editor, " after");

      const children = elementChildren(editor.children[0]);
      const linkIndex = children.findIndex(
        (child) => SlateElement.isElement(child) && child.type === "link",
      );
      expect(linkIndex).toBeGreaterThanOrEqual(0);
      expect(children[linkIndex]).toMatchObject({
        type: "link",
        url: "https://example.com",
        children: [{ text: "Example" }],
      });
      expect(children[linkIndex + 1]).toEqual({ text: " after" });
    });

    it("leaves an empty link destination as literal markdown", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example]");
      editor.insertText(")");

      expect(Node.string(editor.children[0])).toBe("[Example]()");
      expect(
        (editor.children[0] as any).children.some(
          (child: any) => child.type === "link",
        ),
      ).toBe(false);
    });

    it("one undo reverses link-label continuation", () => {
      const editor = makeSchemaEditor();
      type(editor, "[Example");
      editor.insertText("]");

      editor.undo();

      expect(Node.string(editor.children[0])).toBe("[Example");
    });
    it("does not run bracket shortcuts inside inline code", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "[^code", code: true }] },
      ]);
      editor.insertText("]");

      expect(Node.string(editor.children[0])).toBe("[^code]");
      expect(editor.children).toHaveLength(1);
    });

    it("does not run bracket shortcuts inside a code block", () => {
      const editor = makeSchemaEditor([
        {
          type: "code-block",
          children: [{ text: "[^code" }],
        },
      ]);
      editor.insertText("]");

      expect(Node.string(editor.children[0])).toBe("[^code]");
      expect(editor.children.some((node) => isFootnoteDefinition(node))).toBe(
        false,
      );
    });

    it("[^id] delivered as one composed string creates a reference and definition", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[^id]");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "id",
      });
    });

    it("[^id]( delivered as one composed string still creates a footnote", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[^id](");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "id",
      });
    });

    it("[^id](url) delivered as one composed string stays a footnote", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[^id](url)");

      const children = elementChildren(editor.children[0]);
      expect(children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
        ]),
      );
      expect(
        children.some(
          (child) => SlateElement.isElement(child) && child.type === "link",
        ),
      ).toBe(false);
      expect(Node.string(editor.children[0])).toBe("(url)");
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "id",
      });
    });

    it("[label] delivered as one composed string adds exactly one destination pair", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label]");

      expect(Node.string(editor.children[0])).toBe("[label]()");
    });

    it("[label](url) delivered as one composed string creates a link directly", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label](url)");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "link",
            url: "url",
            children: [{ text: "label" }],
          }),
        ]),
      );
      expect(Node.string(editor.children[0])).toBe("label");
    });

    it("[label]() delivered as one composed string remains unchanged", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label]()");

      expect(Node.string(editor.children[0])).toBe("[label]()");
    });

    it("[label](unfinished delivered as one composed string remains unchanged", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[label](unfinished");

      expect(Node.string(editor.children[0])).toBe("[label](unfinished");
    });

    it("composed text without a shortcut keeps the caret at the end", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "*literal " }] },
      ]);
      editor.insertText("composed");

      expect(Node.string(editor.children[0])).toBe("*literal composed");
      expect(editor.selection).toEqual({
        anchor: { path: [0, 0], offset: "*literal composed".length },
        focus: { path: [0, 0], offset: "*literal composed".length },
      });
    });
    it("continues typing in a text spacer when a new link precedes an inline", () => {
      const editor = makeSchemaEditor([
        {
          type: "paragraph",
          children: [
            { text: "" },
            {
              type: "link",
              url: "existing",
              children: [{ text: "existing" }],
            },
            { text: "" },
          ],
        },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: 0 });

      type(editor, "[new]");
      type(editor, "url)");
      editor.insertText("x");

      const children = elementChildren(editor.children[0]);
      const newLinkIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) &&
          child.type === "link" &&
          child.url === "url",
      );
      const existingLinkIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) &&
          child.type === "link" &&
          child.url === "existing",
      );
      expect(children[newLinkIndex + 1]).toEqual({ text: "x" });
      expect(existingLinkIndex).toBe(newLinkIndex + 2);
    });

    it("continues typing in a text spacer when a new footnote precedes an inline", () => {
      const editor = makeSchemaEditor([
        {
          type: "paragraph",
          children: [
            { text: "" },
            {
              type: "link",
              url: "existing",
              children: [{ text: "existing" }],
            },
            { text: "" },
          ],
        },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: 0 });

      type(editor, "[^new]");
      editor.insertText("x");

      const children = elementChildren(editor.children[0]);
      const referenceIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) && child.type === "footnote-ref",
      );
      const existingLinkIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) &&
          child.type === "link" &&
          child.url === "existing",
      );
      expect(children[referenceIndex + 1]).toEqual({ text: "x" });
      expect(existingLinkIndex).toBe(referenceIndex + 2);
    });

    it("keeps typing after the suffix of a composed footnote", () => {
      const editor = makeSchemaEditor();

      editor.insertText("[^id] after");
      editor.insertText("!");

      const children = elementChildren(editor.children[0]);
      const referenceIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) && child.type === "footnote-ref",
      );
      expect(children[referenceIndex + 1]).toEqual({ text: " after!" });
    });

    it("keeps typing after the suffix of a composed link", () => {
      const editor = makeSchemaEditor();

      editor.insertText("[label](url) after");
      editor.insertText("!");

      const children = elementChildren(editor.children[0]);
      const linkIndex = children.findIndex(
        (child) => SlateElement.isElement(child) && child.type === "link",
      );
      expect(children[linkIndex + 1]).toEqual({ text: " after!" });
    });

    it("overtype-closing a link label reuses the existing bracket", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "[Example]" }] },
      ]);
      Transforms.select(editor, {
        path: [0, 0],
        offset: "[Example".length,
      });

      editor.insertText("]");

      expect(Node.string(editor.children[0])).toBe("[Example]()");
      expect(editor.selection).toEqual({
        anchor: { path: [0, 0], offset: "[Example](".length },
        focus: { path: [0, 0], offset: "[Example](".length },
      });
    });

    it("overtype-closing a footnote excludes the existing bracket from its identifier", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "[^id]" }] },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: "[^id".length });

      editor.insertText("]");

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "id",
      });
    });

    it("keeps composed labels and identifiers with an extra bracket literal", () => {
      for (const markdown of ["[a] b]", "[^a] b]"]) {
        const editor = makeSchemaEditor();

        editor.insertText(markdown);

        expect(Node.string(editor.children[0])).toBe(markdown);
        expect(
          elementChildren(editor.children[0]).some((child) =>
            SlateElement.isElement(child),
          ),
        ).toBe(false);
        expect(editor.children).toHaveLength(1);
      }
    });

    it("keeps typed labels and identifiers with a nested opener literal", () => {
      for (const prefix of ["[a [b", "[^a [b"]) {
        const editor = makeSchemaEditor([
          { type: "paragraph", children: [{ text: prefix }] },
        ]);

        editor.insertText("]");

        expect(Node.string(editor.children[0])).toBe(`${prefix}]`);
        expect(
          elementChildren(editor.children[0]).some((child) =>
            SlateElement.isElement(child),
          ),
        ).toBe(false);
        expect(editor.children).toHaveLength(1);
      }
    });
  });

  describe("prefixed external links", () => {
    it("expands a quoted multi-word Wikipedia shorthand on closing quote", () => {
      const editor = makeSchemaEditor();

      type(editor, 'wiki:"Vichy Catalán"');

      expect(elementChildren(editor.children[0])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "link",
            url: "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n",
            children: [{ text: "Vichy Catalán" }],
          }),
        ]),
      );
    });

    it("expands a bare arXiv shorthand on Space and continues in plain text", () => {
      const editor = makeSchemaEditor();

      type(editor, "arxiv:2401.00001 after");

      expect(Node.string(editor.children[0])).toBe("arXiv: 2401.00001 after");
      const children = elementChildren(editor.children[0]);
      const linkIndex = children.findIndex(
        (child) => SlateElement.isElement(child) && child.type === "link",
      );
      expect(linkIndex).toBeGreaterThanOrEqual(0);
      expect(children[linkIndex]).toMatchObject({ type: "link" });
      expect(children[linkIndex + 1]).toEqual({ text: " after" });
    });

    it("expands a bare YouTube shorthand before Enter", () => {
      const editor = makeSchemaEditor();
      type(editor, "youtube:dQw4w9WgXcQ");

      editor.insertBreak();

      expect(editor.children).toHaveLength(2);
      expect(Node.string(editor.children[0])).toBe("YouTube: dQw4w9WgXcQ");
      expect(editor.selection).toEqual({
        anchor: { path: [1, 0], offset: 0 },
        focus: { path: [1, 0], offset: 0 },
      });
    });

    it("expands at the end of a heading, exits to a paragraph, and undoes once", () => {
      const editor = makeSchemaEditor([
        {
          type: "heading",
          level: 2,
          children: [{ text: "arxiv:2401.00001" }],
        },
      ]);

      editor.insertBreak();

      expect(editor.children).toHaveLength(2);
      expect(editor.children[0]).toMatchObject({
        type: "heading",
        level: 2,
        children: expect.arrayContaining([
          expect.objectContaining({
            type: "link",
            url: "https://arxiv.org/abs/2401.00001",
          }),
        ]),
      });
      expect(editor.children[1]).toEqual({
        type: "paragraph",
        children: [{ text: "" }],
      });
      expect(editor.selection).toEqual({
        anchor: { path: [1, 0], offset: 0 },
        focus: { path: [1, 0], offset: 0 },
      });

      editor.undo();

      expect(editor.children).toEqual([
        {
          type: "heading",
          level: 2,
          children: [{ text: "arxiv:2401.00001" }],
        },
      ]);
    });

    it("expands at the end of a list item, continues the list, and undoes once", () => {
      const editor = makeSchemaEditor([
        {
          type: "bulleted-list",
          children: [
            {
              type: "list-item",
              children: [
                {
                  type: "paragraph",
                  children: [{ text: "youtube:dQw4w9WgXcQ" }],
                },
              ],
            },
          ],
        },
      ]);

      editor.insertBreak();

      expect(editor.children).toHaveLength(1);
      expect(editor.children[0]).toMatchObject({
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [
              {
                type: "paragraph",
                children: expect.arrayContaining([
                  expect.objectContaining({
                    type: "link",
                    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                  }),
                ]),
              },
            ],
          },
          {
            type: "list-item",
            children: [
              {
                type: "paragraph",
                children: [{ text: "" }],
              },
            ],
          },
        ],
      });
      expect(editor.selection).toEqual({
        anchor: { path: [0, 1, 0, 0], offset: 0 },
        focus: { path: [0, 1, 0, 0], offset: 0 },
      });

      editor.undo();

      expect(editor.children).toEqual([
        {
          type: "bulleted-list",
          children: [
            {
              type: "list-item",
              children: [
                {
                  type: "paragraph",
                  children: [{ text: "youtube:dQw4w9WgXcQ" }],
                },
              ],
            },
          ],
        },
      ]);
    });

    it("restores the pre-trigger quoted shorthand with one undo", () => {
      const editor = makeSchemaEditor();
      type(editor, 'wiki:"Vichy Catalán"');

      editor.undo();

      expect(Node.string(editor.children[0])).toBe('wiki:"Vichy Catalán');
      expect(elementChildren(editor.children[0])).toEqual([
        { text: 'wiki:"Vichy Catalán' },
      ]);
    });

    it("restores a bare shorthand without its trigger Space with one undo", () => {
      const editor = makeSchemaEditor();
      type(editor, "arxiv:2401.00001 ");

      editor.undo();

      expect(Node.string(editor.children[0])).toBe("arxiv:2401.00001");
      expect(elementChildren(editor.children[0])).toEqual([
        { text: "arxiv:2401.00001" },
      ]);
    });

    it("leaves comma-terminated bare shorthand literal", () => {
      const editor = makeSchemaEditor();

      type(editor, "arxiv:2401.00001,");

      expect(Node.string(editor.children[0])).toBe("arxiv:2401.00001,");
      expect(
        elementChildren(editor.children[0]).some(
          (child) => SlateElement.isElement(child) && child.type === "link",
        ),
      ).toBe(false);
    });

    it.each(["\ud800", "\udc00"])(
      "keeps ill-formed UTF-16 Wikipedia shorthand literal on Space",
      (surrogate) => {
        const shorthand = `wiki:${surrogate}`;
        const editor = makeSchemaEditor();

        type(editor, `${shorthand} `);

        expect(Node.string(editor.children[0])).toBe(`${shorthand} `);
        expect(
          elementChildren(editor.children[0]).some(
            (child) => SlateElement.isElement(child) && child.type === "link",
          ),
        ).toBe(false);
      },
    );

    it("places punctuation after a quoted shorthand in plain text", () => {
      const editor = makeSchemaEditor();

      type(editor, 'wiki:"Vichy Catalán",');
      const children = elementChildren(editor.children[0]);

      const linkIndex = children.findIndex(
        (child) => SlateElement.isElement(child) && child.type === "link",
      );
      expect(linkIndex).toBeGreaterThanOrEqual(0);
      expect(children[linkIndex]).toMatchObject({
        type: "link",
        url: "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n",
        children: [{ text: "Vichy Catalán" }],
      });
      expect(children[linkIndex + 1]).toEqual({ text: "," });
    });

    it("serializes a typed Wikipedia shorthand as a standard Markdown link", () => {
      const editor = makeSchemaEditor();
      type(editor, 'wiki:"Vichy Catalán"');

      expect(slateToMdast(editor.children).trim()).toBe(
        "[Vichy Catalán](https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n)",
      );
    });

    it("serializes a typed YouTube shorthand as a standard Markdown link", () => {
      const editor = makeSchemaEditor();
      type(editor, "youtube:dQw4w9WgXcQ");
      editor.insertBreak();

      expect(slateToMdast(editor.children).trim()).toBe(
        "[YouTube: dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
      );
    });
  });

  describe("footnote shortcut", () => {
    it("creates a reference and one matching definition at document end", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^1]");

      const children = elementChildren(editor.children[0]);
      expect(children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "footnote-ref", identifier: "1" }),
        ]),
      );
      expect(editor.children.at(-1)).toMatchObject({
        type: "footnote-def",
        identifier: "1",
        children: [{ text: "" }],
      });
    });

    it("keeps the caret after the inline reference", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^1]");
      type(editor, "after");

      const children = elementChildren(editor.children[0]);
      const refIndex = children.findIndex(
        (child) =>
          SlateElement.isElement(child) && child.type === "footnote-ref",
      );
      expect(refIndex).toBeGreaterThanOrEqual(0);
      expect(children.slice(refIndex + 1)).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "after" })]),
      );
    });

    it("reuses an existing matching definition", () => {
      const editor = makeSchemaEditor([
        { type: "paragraph", children: [{ text: "" }] },
        {
          type: "footnote-def",
          identifier: "1",
          children: [{ text: "body" }],
        },
        { type: "paragraph", children: [{ text: "tail" }] },
      ]);
      Transforms.select(editor, { path: [0, 0], offset: 0 });
      type(editor, "[^1]");

      expect(
        editor.children.filter((node) => isFootnoteDefinition(node, "1")),
      ).toHaveLength(1);
      expect(editor.children[1]).toMatchObject({
        children: [{ text: "body" }],
      });
    });

    it("multiple references share one definition", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^same] [^same]");

      expect(
        editor.children.filter((node) => isFootnoteDefinition(node, "same")),
      ).toHaveLength(1);
    });

    it("leaves empty footnote and link labels literal", () => {
      const footnote = makeSchemaEditor();
      type(footnote, "[^]");
      expect(Node.string(footnote.children[0])).toBe("[^]");

      const link = makeSchemaEditor();
      type(link, "[]");
      expect(Node.string(link.children[0])).toBe("[]");
    });

    it("one undo removes both the reference shortcut and its new definition", () => {
      const editor = makeSchemaEditor();
      type(editor, "[^undo");
      editor.insertText("]");

      editor.undo();

      expect(Node.string(editor.children[0])).toBe("[^undo");
      expect(editor.children.some((node) => isFootnoteDefinition(node))).toBe(
        false,
      );
    });
  });

  describe("regression guards", () => {
    it("RG-03: / in https:// does not trigger slash", () => {
      const editor = makeEditor();
      type(editor, "https://");
      expect(Node.string(editor.children[0])).toBe("https://");
    });
  });

  describe("insertBreak", () => {
    it("RG-02: code fence ```ts + Enter creates code-block", () => {
      const editor = makeEditor();
      type(editor, "```ts");
      editor.insertBreak();
      expect((editor.children[0] as any).type).toBe("code-block");
      expect((editor.children[0] as any).language).toBe("ts");
    });

    it("Enter in list item creates new item", () => {
      const editor = makeEditor();
      type(editor, "- hello");
      editor.insertBreak();
      const list = editor.children[0] as any;
      expect(list.type).toBe("bulleted-list");
      expect(list.children.length).toBe(2);
    });
  });

  describe("heading exit on Enter", () => {
    it("Enter at end of a heading creates a paragraph below (reverts style)", () => {
      const editor = makeEditor([
        { type: "heading", level: 2, children: [{ text: "Title" }] },
      ]);
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 5 },
        focus: { path: [0, 0], offset: 5 },
      });
      editor.insertBreak();
      expect((editor.children[0] as any).type).toBe("heading");
      expect((editor.children[1] as any).type).toBe("paragraph");
      // Cursor lands in the new paragraph.
      expect(editor.selection?.anchor.path).toEqual([1, 0]);
    });

    it("Enter on an empty heading creates a paragraph", () => {
      const editor = makeEditor([
        { type: "heading", level: 1, children: [{ text: "" }] },
      ]);
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 0 },
      });
      editor.insertBreak();
      expect((editor.children[1] as any).type).toBe("paragraph");
    });

    it("Enter in the middle of a heading splits into two headings", () => {
      const editor = makeEditor([
        { type: "heading", level: 2, children: [{ text: "Title" }] },
      ]);
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 2 },
        focus: { path: [0, 0], offset: 2 },
      });
      editor.insertBreak();
      expect((editor.children[0] as any).type).toBe("heading");
      expect((editor.children[1] as any).type).toBe("heading");
    });
  });

  describe("code block Enter (insertBreak)", () => {
    it("Enter inside a code block inserts a newline, not a new block", () => {
      const editor = makeEditor([
        {
          type: "code-block",
          language: "ts",
          children: [{ text: "const x = 1" }],
        },
      ]);
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 11 },
        focus: { path: [0, 0], offset: 11 },
      });
      editor.insertBreak();
      // Still a single code-block, now containing a trailing newline.
      expect(editor.children.length).toBe(1);
      expect((editor.children[0] as any).type).toBe("code-block");
      expect(Node.string(editor.children[0])).toBe("const x = 1\n");
    });

    it("Enter mid-code inserts the newline at the cursor", () => {
      const editor = makeEditor([
        { type: "code-block", children: [{ text: "ab" }] },
      ]);
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 1 },
        focus: { path: [0, 0], offset: 1 },
      });
      editor.insertBreak();
      expect(editor.children.length).toBe(1);
      expect((editor.children[0] as any).type).toBe("code-block");
      expect(Node.string(editor.children[0])).toBe("a\nb");
    });
  });

  // Regression: IME / dead-key composition commits text through a single
  // multi-character insertText call (slate-react onCompositionEnd ->
  // Editor.insertText(editor, event.data)). The autoformat override used to
  // bail on any text.length !== 1, so composed markdown delimiters (a dead-key
  // backtick is the canonical case) were stored as literal text and escaped on
  // save. These assert that complete delimiter pairs in a multi-char insert are
  // resolved into Slate marks/elements, matching char-by-char typing.
  describe("composition / multi-char insertText (IME & dead-key)", () => {
    function leaves(editor: Editor) {
      return (editor.children[0] as any).children;
    }

    it("`code` delivered as one composed string applies the code mark", () => {
      const editor = makeEditor();
      editor.insertText("`code`");
      expect(leaves(editor).some((l: any) => l.code && l.text === "code")).toBe(
        true,
      );
      expect(Node.string(editor.children[0])).toBe("code");
    });

    it("closing backtick fused with the next char (dead-key) still resolves", () => {
      const editor = makeEditor();
      type(editor, "`code"); // opener + content typed normally
      editor.insertText("`x"); // dead-key closer commits fused with following char
      expect(leaves(editor).some((l: any) => l.code && l.text === "code")).toBe(
        true,
      );
      // the fused trailing character survives as plain text after the span
      expect(Node.string(editor.children[0])).toBe("codex");
    });

    it("~struck~ composed string applies strikethrough", () => {
      const editor = makeEditor();
      editor.insertText("~struck~");
      expect(
        leaves(editor).some((l: any) => l.strikethrough && l.text === "struck"),
      ).toBe(true);
    });

    it("*it* composed string applies italic", () => {
      const editor = makeEditor();
      editor.insertText("*it*");
      expect(leaves(editor).some((l: any) => l.italic && l.text === "it")).toBe(
        true,
      );
    });

    it("**bo** composed string applies bold", () => {
      const editor = makeEditor();
      editor.insertText("**bo**");
      expect(leaves(editor).some((l: any) => l.bold && l.text === "bo")).toBe(
        true,
      );
    });

    it("[t](https://a.b) composed string applies a link element", () => {
      const editor = makeSchemaEditor();
      editor.insertText("[t](https://a.b)");
      const link = leaves(editor).find((c: any) => c.type === "link");
      expect(link).toBeDefined();
      expect(link.url).toBe("https://a.b");
      expect(link.children[0].text).toBe("t");
    });

    it("plain composed text with no delimiters is left untouched", () => {
      const editor = makeEditor();
      editor.insertText("hello world");
      expect(Node.string(editor.children[0])).toBe("hello world");
      expect(leaves(editor).every((l: any) => !l.code && !l.bold)).toBe(true);
    });

    it("composed text with an unpaired delimiter is left untouched", () => {
      const editor = makeEditor();
      editor.insertText("a ) b");
      expect(Node.string(editor.children[0])).toBe("a ) b");
      expect(leaves(editor).some((c: any) => c.type === "link")).toBe(false);
    });
  });
});
