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
  if (!editor.selection || !Range.isCollapsed(editor.selection)) {
    return null;
  }

  try {
    const domRange = ReactEditor.toDOMRange(
      editor as Editor & ReactEditor,
      editor.selection,
    );

    return {
      getBoundingClientRect: () => getDomRangeRect(domRange),
      getClientRects: () => domRange.getClientRects(),
    };
  } catch {
    return null;
  }
}
