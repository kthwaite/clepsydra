import type { VirtualElement } from "@floating-ui/react";
import { type BaseRange, type Editor, Range } from "slate";
import { ReactEditor } from "slate-react";

function getDomRangeRect(domRange: globalThis.Range): DOMRect {
  const rect = domRange.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }

  const firstClientRect = domRange.getClientRects().item(0);
  if (firstClientRect) {
    return firstClientRect;
  }

  return rect;
}

function cloneRange(range: BaseRange): BaseRange {
  return {
    anchor: {
      path: [...range.anchor.path],
      offset: range.anchor.offset,
    },
    focus: {
      path: [...range.focus.path],
      offset: range.focus.offset,
    },
  };
}

function createVirtualRangeReference(
  editor: Editor,
  range: BaseRange,
  contextElement?: Element,
): VirtualElement {
  const selection = cloneRange(range);
  const resolveDomRange = (): globalThis.Range | null => {
    try {
      return ReactEditor.toDOMRange(editor as Editor & ReactEditor, selection);
    } catch {
      return null;
    }
  };

  return {
    contextElement,
    getBoundingClientRect: () => {
      const domRange = resolveDomRange();
      return domRange ? getDomRangeRect(domRange) : new DOMRect();
    },
    getClientRects: () => {
      const domRange = resolveDomRange();
      return domRange
        ? domRange.getClientRects()
        : ([] as unknown as DOMRectList);
    },
  };
}

export function createSelectionReference(
  editor: Editor,
): VirtualElement | null {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) {
    return null;
  }

  // This is called during render, where the DOM may not yet contain the text
  // the selection points at (React commits it afterwards) — resolving the DOM
  // range eagerly would fail there. Floating UI measures after commit, so the
  // resolution must happen per-measurement, not at creation.
  return createVirtualRangeReference(editor, selection);
}

export function createRangeReference(
  editor: Editor,
  range: BaseRange,
): VirtualElement | null {
  if (
    Range.isCollapsed(range) ||
    typeof globalThis.Range === "undefined" ||
    typeof globalThis.Range.prototype.getBoundingClientRect !== "function" ||
    typeof globalThis.Range.prototype.getClientRects !== "function"
  ) {
    return null;
  }

  try {
    const reactEditor = editor as Editor & ReactEditor;
    const contextElement = ReactEditor.toDOMNode(reactEditor, editor);
    return createVirtualRangeReference(editor, range, contextElement);
  } catch {
    return null;
  }
}
