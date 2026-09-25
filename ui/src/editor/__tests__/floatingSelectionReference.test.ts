import { type BaseSelection, createEditor, Range } from "slate";
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
  const editor = createEditor();
  editor.selection = selection;
  return editor;
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
    expect(editor.selection && Range.isCollapsed(editor.selection)).toBe(true);

    const reference = createSelectionReference(editor);
    expect(reference).not.toBeNull();

    // First measurement: DOM unresolvable, falls back without throwing.
    expect(reference?.getBoundingClientRect().width).toBe(0);

    // Once the DOM has caught up, measurements reflect the real range.
    expect(reference?.getBoundingClientRect()).toBe(rect);
    expect(reference?.getClientRects?.()).toEqual([rect]);
  });
});
