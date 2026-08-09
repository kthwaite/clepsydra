import {
  createEditor,
  type Descendant,
  type Editor,
  Node,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it, vi } from "vitest";
import { withSchema } from "../../../schema/withSchema";
import type { CustomEditor } from "../../../types";
import {
  tryPrefixedLinkBreakTransform,
  tryPrefixedLinkTextTransform,
} from "../prefixedLinkTransform";

function editorWithChildren(
  children: Descendant[],
  path: number[] | null,
  offset = 0,
) {
  const editor = withHistory(withSchema(createEditor()));
  editor.children = structuredClone(children);
  if (path) {
    Transforms.select(editor, {
      anchor: { path, offset },
      focus: { path, offset },
    });
  }
  return editor;
}

function editorWith(text: string, offset = text.length) {
  return editorWithChildren(
    [{ type: "paragraph", children: [{ text }] }],
    [0, 0],
    offset,
  );
}

function firstLink(editor: Editor) {
  const paragraph = editor.children[0] as {
    children: Array<{ type?: string; url?: string; children?: unknown[] }>;
  };
  return paragraph.children.find((child) => child.type === "link");
}

function expectRejectedWithoutMutation(editor: Editor) {
  const before = structuredClone(editor.children);
  expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(false);
  expect(editor.children).toEqual(before);
}

describe("prefixed link text transform", () => {
  it('replaces wiki:"Vichy Catalán" after a consumed closing quote', () => {
    const editor = editorWith('wiki:"Vichy Catalán"');

    expect(tryPrefixedLinkTextTransform(editor, '"', true)).toBe(true);
    expect(editor.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { text: "" },
        {
          type: "link",
          url: "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n",
          children: [{ text: "Vichy Catalán" }],
        },
        { text: "" },
      ],
    });
  });

  it("replaces an open quoted value when the closing quote is uninserted", () => {
    const editor = editorWith('wiki:"Vichy Catalán');

    expect(tryPrefixedLinkTextTransform(editor, '"')).toBe(true);
    expect(editor.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { text: "" },
        {
          type: "link",
          url: "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n",
          children: [{ text: "Vichy Catalán" }],
        },
        { text: "" },
      ],
    });
  });

  it("replaces a bare arXiv value and retains one trailing space", () => {
    const editor = editorWith("Read arxiv:2401.00001");

    expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(true);
    expect(Node.string(editor.children[0])).toBe("Read arXiv: 2401.00001 ");
    expect(firstLink(editor)).toMatchObject({
      url: "https://arxiv.org/abs/2401.00001",
      children: [{ text: "arXiv: 2401.00001" }],
    });
  });

  it("undoes expansion and its delimiter as one action", () => {
    const editor = editorWith("arxiv:2401.00001");

    expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(true);
    editor.undo();

    expect(Node.string(editor.children[0])).toBe("arxiv:2401.00001");
    expect(editor.children[0]).toEqual({
      type: "paragraph",
      children: [{ text: "arxiv:2401.00001" }],
    });
  });

  it.each([
    "examplewiki:Hypertext",
    'wiki:"unterminated',
    "arxiv:not-an-id",
    "youtube:short",
    "doi:10.1000/example",
  ])("rejects invalid candidate %s without mutation", (text) => {
    expectRejectedWithoutMutation(editorWith(text));
  });

  it.each([
    ["(", "(arXiv: 2401.00001 "],
    ["—", "—arXiv: 2401.00001 "],
    ["Before ", "Before arXiv: 2401.00001 "],
  ])("preserves the %s boundary before a candidate", (boundary, expected) => {
    const editor = editorWith(`${boundary}arxiv:2401.00001`);

    expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(true);
    expect(Node.string(editor.children[0])).toBe(expected);
  });

  it("inspects only the caret's current text leaf", () => {
    const editor = editorWithChildren(
      [
        {
          type: "paragraph",
          children: [{ text: "arxiv:" }, { text: "2401.00001" }],
        },
      ],
      [0, 1],
      10,
    );

    expectRejectedWithoutMutation(editor);
  });
});

describe("prefixed link break transform", () => {
  it("expands a bare YouTube ID before the normal block break", () => {
    const editor = editorWith("youtube:dQw4w9WgXcQ");
    const originalInsertBreak = editor.insertBreak.bind(editor);
    const insertBreak = vi.fn(() => originalInsertBreak());

    expect(tryPrefixedLinkBreakTransform(editor, insertBreak)).toBe(true);
    expect(insertBreak).toHaveBeenCalledOnce();
    expect(editor.children).toHaveLength(2);
    expect(Node.string(editor.children[0])).toBe("YouTube: dQw4w9WgXcQ");
    expect(Node.string(editor.children[1])).toBe("");
  });

  it("undoes expansion and the normal block break as one action", () => {
    const editor = editorWith("youtube:dQw4w9WgXcQ");
    const originalInsertBreak = editor.insertBreak.bind(editor);

    expect(
      tryPrefixedLinkBreakTransform(editor, () => originalInsertBreak()),
    ).toBe(true);
    editor.undo();

    expect(editor.children).toEqual([
      {
        type: "paragraph",
        children: [{ text: "youtube:dQw4w9WgXcQ" }],
      },
    ]);
  });

  it("returns false without invoking the break for an invalid candidate", () => {
    const editor = editorWith("youtube:short");
    const insertBreak = vi.fn();
    const before = structuredClone(editor.children);

    expect(tryPrefixedLinkBreakTransform(editor, insertBreak)).toBe(false);
    expect(insertBreak).not.toHaveBeenCalled();
    expect(editor.children).toEqual(before);
  });
});

describe("prefixed link context guards", () => {
  const protectedFixtures: Array<{
    name: string;
    create: () => CustomEditor;
  }> = [
    {
      name: "an expanded selection",
      create: () => {
        const editor = editorWith("arxiv:2401.00001");
        Transforms.select(editor, {
          anchor: { path: [0, 0], offset: 0 },
          focus: { path: [0, 0], offset: 18 },
        });
        return editor;
      },
    },
    {
      name: "a code block",
      create: () =>
        editorWithChildren(
          [
            {
              type: "code-block",
              children: [{ text: "arxiv:2401.00001" }],
            },
          ],
          [0, 0],
          18,
        ),
    },
    {
      name: "a code-marked text leaf",
      create: () =>
        editorWithChildren(
          [
            {
              type: "paragraph",
              children: [{ text: "arxiv:2401.00001", code: true }],
            },
          ],
          [0, 0],
          18,
        ),
    },
    ...[
      ["link", { url: "https://example.com" }],
      ["wikilink", { target: "Existing page" }],
      ["block-ref", { blockId: "block-id" }],
      ["footnote-ref", { identifier: "note" }],
    ].map(([type, attributes]) => ({
      name: `an existing ${type} element`,
      create: () =>
        editorWithChildren(
          [
            {
              type: "paragraph",
              children: [
                {
                  type,
                  ...(attributes as object),
                  children: [{ text: "arxiv:2401.00001" }],
                },
              ],
            },
          ] as Descendant[],
          [0, 0, 0],
          18,
        ),
    })),
  ];

  it("rejects an absent selection", () => {
    const editor = editorWithChildren(
      [{ type: "paragraph", children: [{ text: "arxiv:2401.00001" }] }],
      null,
    );
    const insertBreak = vi.fn();
    const before = structuredClone(editor.children);

    expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(false);
    expect(tryPrefixedLinkBreakTransform(editor, insertBreak)).toBe(false);
    expect(insertBreak).not.toHaveBeenCalled();
    expect(editor.children).toEqual(before);
  });

  it("rejects a selection anchor that is not a text leaf", () => {
    const editor = editorWith("arxiv:2401.00001");
    editor.selection = {
      anchor: { path: [0], offset: 0 },
      focus: { path: [0], offset: 0 },
    };
    const insertBreak = vi.fn();
    const before = structuredClone(editor.children);

    expect(tryPrefixedLinkTextTransform(editor, " ")).toBe(false);
    expect(tryPrefixedLinkBreakTransform(editor, insertBreak)).toBe(false);
    expect(insertBreak).not.toHaveBeenCalled();
    expect(editor.children).toEqual(before);
  });

  it.each(protectedFixtures)("rejects $name", ({ create }) => {
    const textEditor = create();
    const textBefore = structuredClone(textEditor.children);

    expect(tryPrefixedLinkTextTransform(textEditor, " ")).toBe(false);
    expect(textEditor.children).toEqual(textBefore);

    const breakEditor = create();
    const insertBreak = vi.fn();
    const breakBefore = structuredClone(breakEditor.children);

    expect(tryPrefixedLinkBreakTransform(breakEditor, insertBreak)).toBe(false);
    expect(insertBreak).not.toHaveBeenCalled();
    expect(breakEditor.children).toEqual(breakBefore);
  });
});
