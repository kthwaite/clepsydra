import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createEditor,
  Node,
  Transforms,
  type Descendant,
  type Editor,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { makeWikilink } from "../schema/elements/wikilink";
import { withSchema } from "../schema/withSchema";
import {
  findAdjacentWikilink,
  parseWikilinkDraft,
  useWikilinkEditing,
  useWikilinkEditingController,
  WikilinkEditingProvider,
} from "../wikilinkEditing";

function createWikilinkEditor(): Editor {
  const editor = withSchema(withHistory(createEditor()));
  editor.children = [
    {
      type: "paragraph",
      children: [
        { text: "before" },
        makeWikilink({ target: "Target", alias: "Old Label" }),
        { text: "after" },
      ],
    },
  ] as Descendant[];
  return editor;
}

function controllerWrapper(editor: Editor) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <WikilinkEditingProvider editor={editor}>
        {children}
      </WikilinkEditingProvider>
    );
  };
}

describe("parseWikilinkDraft", () => {
  it.each([
    ["Target", { target: "Target" }],
    ["Target|Label", { target: "Target", alias: "Label" }],
    ["Target|", { target: "Target" }],
    ["Target|Label|Detail", { target: "Target", alias: "Label|Detail" }],
  ])("parses %s", (draft, expected) => {
    expect(parseWikilinkDraft(draft)).toEqual(expected);
  });

  it("rejects a target that is empty after trimming", () => {
    expect(parseWikilinkDraft("   |Label")).toBeNull();
  });

  it("preserves non-empty target and alias whitespace", () => {
    expect(parseWikilinkDraft(" Target | Label ")).toEqual({
      target: " Target ",
      alias: " Label ",
    });
  });
});

describe("findAdjacentWikilink", () => {
  it("finds the wikilink after a caret at the end of the preceding text", () => {
    const editor = createWikilinkEditor();
    Transforms.select(editor, { path: [0, 0], offset: "before".length });

    expect(findAdjacentWikilink(editor, "ArrowRight")).toEqual({
      path: [0, 1],
      caret: "start",
      returnSide: "before",
    });
  });

  it("finds the wikilink before a caret at the start of the following text", () => {
    const editor = createWikilinkEditor();
    Transforms.select(editor, { path: [0, 2], offset: 0 });

    expect(findAdjacentWikilink(editor, "ArrowLeft")).toEqual({
      path: [0, 1],
      caret: "end",
      returnSide: "after",
    });
  });

  it.each(["ArrowLeft", "ArrowRight"] as const)(
    "returns null for an expanded selection with %s",
    (key) => {
      const editor = createWikilinkEditor();
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: "before".length },
      });

      expect(findAdjacentWikilink(editor, key)).toBeNull();
    },
  );

  it.each([
    ["ArrowRight", [0, 0], 2],
    ["ArrowLeft", [0, 2], 2],
  ] as const)(
    "returns null for a non-boundary offset with %s",
    (key, path, offset) => {
      const editor = createWikilinkEditor();
      Transforms.select(editor, { path: [...path], offset });

      expect(findAdjacentWikilink(editor, key)).toBeNull();
    },
  );

  it.each([
    ["ArrowLeft", [0, 0], "before".length],
    ["ArrowRight", [0, 2], 0],
  ] as const)(
    "returns null for the wrong direction %s",
    (key, path, offset) => {
      const editor = createWikilinkEditor();
      Transforms.select(editor, { path: [...path], offset });

      expect(findAdjacentWikilink(editor, key)).toBeNull();
    },
  );

  it("returns null when the adjacent sibling is not a wikilink", () => {
    const editor = withSchema(withHistory(createEditor()));
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "before" },
          { type: "link", url: "https://example.com", children: [{ text: "link" }] },
          { text: "after" },
        ],
      },
    ] as Descendant[];
    Transforms.select(editor, { path: [0, 0], offset: "before".length });

    expect(findAdjacentWikilink(editor, "ArrowRight")).toBeNull();
  });
});

describe("useWikilinkEditingController", () => {
  it("commits target and alias, exits after, and undoes both mutations together", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useWikilinkEditingController(editor));

    act(() => result.current.begin([0, 1], "end", "after"));
    expect(result.current.active).toEqual({
      path: [0, 1],
      initialCaret: "end",
      returnSide: "after",
    });

    act(() =>
      result.current.commit(
        { target: "New Target", alias: "Label" },
        "after",
      ),
    );
    expect(result.current.active).toBeNull();
    expect(Node.get(editor, [0, 1])).toMatchObject({
      type: "wikilink",
      target: "New Target",
      alias: "Label",
    });
    expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });

    act(() => editor.undo());
    expect(Node.get(editor, [0, 1])).toMatchObject({
      target: "Target",
      alias: "Old Label",
    });
  });

  it("removes an existing alias when the committed alias is undefined", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useWikilinkEditingController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => result.current.commit({ target: "Target without alias" }, "preserve"));

    expect(Node.get(editor, [0, 1])).toMatchObject({
      type: "wikilink",
      target: "Target without alias",
    });
    expect(Node.get(editor, [0, 1])).not.toHaveProperty("alias");
  });

  it("cancels without mutation and exits before the wikilink", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useWikilinkEditingController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => result.current.cancel("before"));

    expect(result.current.active).toBeNull();
    expect(Node.get(editor, [0, 1])).toMatchObject({
      target: "Target",
      alias: "Old Label",
    });
    expect(editor.selection?.anchor).toEqual({
      path: [0, 0],
      offset: "before".length,
    });
  });

  it("preserves the current Slate selection when committing with preserve", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useWikilinkEditingController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => Transforms.select(editor, { path: [0, 0], offset: 2 }));
    const selection = editor.selection;
    act(() => result.current.commit({ target: "New Target" }, "preserve"));

    expect(editor.selection).toEqual(selection);
  });

  it("replaces an active session when begin is called again", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useWikilinkEditingController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => result.current.begin([0, 1], "end", "after"));

    expect(result.current.active).toEqual({
      path: [0, 1],
      initialCaret: "end",
      returnSide: "after",
    });
  });
});

describe("WikilinkEditingProvider", () => {
  it("provides the editor-specific controller", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useWikilinkEditing(), {
      wrapper: controllerWrapper(editor),
    });

    act(() => result.current.begin([0, 1], "start", "before"));

    expect(result.current.active).toEqual({
      path: [0, 1],
      initialCaret: "start",
      returnSide: "before",
    });
  });

  it("throws a descriptive error outside the provider", () => {
    expect(() => renderHook(() => useWikilinkEditing())).toThrow(
      "useWikilinkEditing must be used within a WikilinkEditingProvider",
    );
  });
});
