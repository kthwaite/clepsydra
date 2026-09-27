import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createEditor,
  type Descendant,
  type Editor,
  Node,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it, vi } from "vitest";
import { INLINE_SOURCE_ADAPTERS } from "../inlineSourceAdapters";
import {
  findAdjacentSourceInline,
  type InlineSourceAdapter,
  type InlineSourceEditingController,
  InlineSourceEditingProvider,
  useInlineSourceEditing,
  useInlineSourceEditingController,
} from "../inlineSourceEditing";
import { makeWikilink } from "../schema/elements/wikilink";
import { withSchema } from "../schema/withSchema";
import { parseWikilinkDraft } from "../wikilinkSourceAdapter";

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

function controllerWrapper(controller: InlineSourceEditingController) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <InlineSourceEditingProvider value={controller}>
        {children}
      </InlineSourceEditingProvider>
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

describe("findAdjacentSourceInline", () => {
  it("finds the wikilink after a caret at the end of the preceding text", () => {
    const editor = createWikilinkEditor();
    Transforms.select(editor, { path: [0, 0], offset: "before".length });

    expect(
      findAdjacentSourceInline(editor, "ArrowRight", ["wikilink"]),
    ).toEqual({
      path: [0, 1],
      caret: "start",
      returnSide: "before",
    });
  });

  it("finds the wikilink before a caret at the start of the following text", () => {
    const editor = createWikilinkEditor();
    Transforms.select(editor, { path: [0, 2], offset: 0 });

    expect(findAdjacentSourceInline(editor, "ArrowLeft", ["wikilink"])).toEqual(
      {
        path: [0, 1],
        caret: "end",
        returnSide: "after",
      },
    );
  });

  it.each(["ArrowLeft", "ArrowRight"] as const)(
    "returns null for an expanded selection with %s",
    (key) => {
      const editor = createWikilinkEditor();
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: "before".length },
      });

      expect(findAdjacentSourceInline(editor, key, ["wikilink"])).toBeNull();
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

      expect(findAdjacentSourceInline(editor, key, ["wikilink"])).toBeNull();
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

      expect(findAdjacentSourceInline(editor, key, ["wikilink"])).toBeNull();
    },
  );

  it("returns null when the adjacent sibling is not a wikilink", () => {
    const editor = withSchema(withHistory(createEditor()));
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "before" },
          {
            type: "link",
            url: "https://example.com",
            children: [{ text: "link" }],
          },
          { text: "after" },
        ],
      },
    ] as Descendant[];
    Transforms.select(editor, { path: [0, 0], offset: "before".length });

    expect(
      findAdjacentSourceInline(editor, "ArrowRight", ["wikilink"]),
    ).toBeNull();
  });
});

function useController(editor: Editor) {
  return useInlineSourceEditingController(editor, INLINE_SOURCE_ADAPTERS);
}

function sessionShape(controller: InlineSourceEditingController) {
  const session = controller.active;
  if (!session) return null;
  return {
    type: session.type,
    path: session.ref.current,
    initialCaret: session.initialCaret,
    returnSide: session.returnSide,
  };
}

describe("useInlineSourceEditingController", () => {
  it("commits target and alias, exits after, and undoes both mutations together", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "end", "after"));
    expect(sessionShape(result.current)).toEqual({
      type: "wikilink",
      path: [0, 1],
      initialCaret: "end",
      returnSide: "after",
    });

    act(() => result.current.commit("New Target|Label", "after"));
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
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => result.current.commit("Target without alias", "preserve"));

    expect(Node.get(editor, [0, 1])).toMatchObject({
      type: "wikilink",
      target: "Target without alias",
    });
    expect(Node.get(editor, [0, 1])).not.toHaveProperty("alias");
  });

  it("cancels without mutation and exits before the wikilink", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

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
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => Transforms.select(editor, { path: [0, 0], offset: 2 }));
    const selection = editor.selection;
    act(() => result.current.commit("New Target", "preserve"));

    expect(editor.selection).toEqual(selection);
  });

  it("replaces an active session when begin is called again", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => result.current.begin([0, 1], "end", "after"));

    expect(sessionShape(result.current)).toEqual({
      type: "wikilink",
      path: [0, 1],
      initialCaret: "end",
      returnSide: "after",
    });
  });
});

describe("inline source sessions", () => {
  it("tracks the element when text is inserted before it mid-session", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "end", "after"));
    act(() =>
      Transforms.insertNodes(
        editor,
        { type: "paragraph", children: [{ text: "new first" }] },
        { at: [0] },
      ),
    );
    expect(result.current.active?.ref.current).toEqual([1, 1]);

    act(() => result.current.commit("Moved Target", "after"));
    expect(Node.get(editor, [1, 1])).toMatchObject({
      type: "wikilink",
      target: "Moved Target",
    });
    expect(editor.selection?.anchor).toEqual({ path: [1, 2], offset: 0 });
  });

  it("closes without mutation when the element was removed mid-session", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "end", "after"));
    act(() => Transforms.removeNodes(editor, { at: [0, 1] }));
    const before = structuredClone(editor.children);

    act(() => result.current.commit("Ghost", "preserve"));
    expect(result.current.active).toBeNull();
    expect(editor.children).toEqual(before);
  });

  it("keeps the session open when the adapter reports an invalid draft", () => {
    const editor = createWikilinkEditor();
    const strict: InlineSourceAdapter = {
      type: "wikilink",
      label: "Edit strict",
      toDraft: () => "",
      parse: (draft) =>
        draft === "ok"
          ? {
              kind: "commit",
              apply: (ed, path) =>
                Transforms.setNodes(ed, { target: "ok" }, { at: path }),
            }
          : { kind: "invalid" },
    };
    const adapters = [strict];
    const { result } = renderHook(() =>
      useInlineSourceEditingController(editor, adapters),
    );

    act(() => result.current.begin([0, 1], "end", "after"));
    let outcome: string | null = null;
    act(() => {
      outcome = result.current.commit("bad", "after");
    });

    expect(outcome).toBe("invalid");
    expect(sessionShape(result.current)).toMatchObject({ path: [0, 1] });
    expect(Node.get(editor, [0, 1])).toMatchObject({ target: "Target" });

    act(() => {
      outcome = result.current.commit("ok", "after");
    });
    expect(outcome).toBe("commit");
    expect(result.current.active).toBeNull();
    expect(Node.get(editor, [0, 1])).toMatchObject({ target: "ok" });
  });

  it("cancels the session when the adapter parse says cancel", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 1], "start", "before"));
    act(() => {
      result.current.commit("   |Label", "before");
    });

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

  it("ignores begin on an element type without an adapter", () => {
    const editor = createWikilinkEditor();
    const { result } = renderHook(() => useController(editor));

    act(() => result.current.begin([0, 0], "start", "before"));

    expect(result.current.active).toBeNull();
  });
});

describe("InlineSourceEditingProvider", () => {
  it("provides the supplied controller unchanged", () => {
    const controller: InlineSourceEditingController = {
      active: null,
      begin: vi.fn(),
      commit: vi.fn(),
      cancel: vi.fn(),
    };
    const { result } = renderHook(() => useInlineSourceEditing(), {
      wrapper: controllerWrapper(controller),
    });

    expect(result.current).toBe(controller);
  });

  it("throws a descriptive error outside the provider", () => {
    expect(() => renderHook(() => useInlineSourceEditing())).toThrow(
      "useInlineSourceEditing must be used within an InlineSourceEditingProvider",
    );
  });
});
