import { Range } from "slate";
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

describe("createSelectionReference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there is no collapsed selection", () => {
    const editor = {
      children: [],
      operations: [],
      selection: null,
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

    expect(createSelectionReference(editor)).toBeNull();
  });

  it("returns null when Slate DOM range resolution fails", () => {
    vi.mocked(ReactEditor.toDOMRange).mockImplementation(() => {
      throw new Error("no dom range");
    });

    const editor = {
      children: [],
      operations: [],
      selection: {
        anchor: { path: [0, 0], offset: 2 },
        focus: { path: [0, 0], offset: 2 },
      },
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

    expect(Range.isCollapsed(editor.selection)).toBe(true);
    expect(createSelectionReference(editor)).toBeNull();
  });
});
