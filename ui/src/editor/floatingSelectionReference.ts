import type { VirtualElement } from "@floating-ui/react";
import { type Editor, Range } from "slate";
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
  const resolveDomRange = (): globalThis.Range | null => {
    try {
      return ReactEditor.toDOMRange(editor as Editor & ReactEditor, selection);
    } catch {
      return null;
    }
  };

  return {
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
