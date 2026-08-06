import { type BaseSelection, Range } from "slate";
import { ReactEditor } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectionReference } from "../floatingSelectionReference";

vi.mock("slate-react", async () => {
  const actual =
    await vi.importActual<typeof import("slate-react")>("slate-react");
  return {
    ...actual,
    ReactEditor: {
      ...actual.ReactEditor,
      toDOMRange: vi.fn(),
    },
  };
});

function makeEditor(selection: BaseSelection) {
  return {
    children: [],
    operations: [],
    selection,
    marks: null,
    isInline: () => false,
    isVoid: () => false,
    apply: () => undefined,
    normalizeNode: () => undefined,
    onChange: () => undefined,
    insertText: () => undefined,
    deleteBackward: () => undefined,
    deleteForward: () => undefined,
    deleteFragment: () => undefined,
    addMark: () => undefined,
    removeMark: () => undefined,
    insertBreak: () => undefined,
    insertSoftBreak: () => undefined,
    insertFragment: () => undefined,
    insertNode: () => undefined,
    setNodes: () => undefined,
    setFragmentData: () => undefined,
    getFragment: () => [],
    getDirtyPaths: () => [],
    shouldNormalize: () => true,
  } as any;
}

describe("createSelectionReference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there is no collapsed selection", () => {
    expect(createSelectionReference(makeEditor(null))).toBeNull();

    expect(
      createSelectionReference(
        makeEditor({
          anchor: { path: [0, 0], offset: 0 },
          focus: { path: [0, 0], offset: 2 },
        }),
      ),
    ).toBeNull();
  });

  it("defers DOM range resolution to measure time", () => {
    const rect = { x: 10, y: 20, width: 5, height: 15 } as DOMRect;
    const domRange = {
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect] as unknown as DOMRectList,
    } as unknown as globalThis.Range;

    // The reference is created during render, before React commits the
    // just-typed text — the first resolution fails, later ones succeed.
    vi.mocked(ReactEditor.toDOMRange)
      .mockImplementationOnce(() => {
        throw new Error("DOM not committed yet");
      })
      .mockImplementation(() => domRange);

    const editor = makeEditor({
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 2 },
    });
    expect(Range.isCollapsed(editor.selection)).toBe(true);

    const reference = createSelectionReference(editor);
    expect(reference).not.toBeNull();

    // First measurement: DOM unresolvable, falls back without throwing.
    expect(reference?.getBoundingClientRect().width).toBe(0);

    // Once the DOM has caught up, measurements reflect the real range.
    expect(reference?.getBoundingClientRect()).toBe(rect);
    expect(reference?.getClientRects?.()).toEqual([rect]);
  });
});
