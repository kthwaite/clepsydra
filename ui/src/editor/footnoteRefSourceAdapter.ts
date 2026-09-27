import { Node, Transforms } from "slate";
import type { InlineSourceAdapter } from "#/editor/inlineSourceEditing";
import { ensureFootnoteDef } from "#/editor/transforms/footnotes";
import type { FootnoteRefElement } from "#/editor/types";

// Whitespace and brackets would not survive a `[^id]` round trip.
const UNSAFE_IDENTIFIER = /[\s[\]]/;

/**
 * Edits a `[^id]` reference. A new identifier repoints the ref only; a
 * missing def is appended empty, and the old def is left alone.
 */
export const footnoteRefSourceAdapter: InlineSourceAdapter<FootnoteRefElement> =
  {
    type: "footnote-ref",
    label: "Edit footnote reference",
    chrome: { open: "[^", close: "]" },
    toDraft: (element) => element.identifier,
    parse(draft) {
      const identifier = draft.trim();
      if (identifier.length === 0) return { kind: "cancel" };
      if (UNSAFE_IDENTIFIER.test(identifier)) return { kind: "invalid" };
      return {
        kind: "commit",
        apply(editor, path) {
          const current = Node.get(editor, path) as FootnoteRefElement;
          if (current.identifier === identifier) return;
          Transforms.setNodes(editor, { identifier }, { at: path });
          ensureFootnoteDef(editor, identifier);
        },
      };
    },
  };
