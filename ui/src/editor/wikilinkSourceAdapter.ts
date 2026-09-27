import { Transforms } from "slate";
import type { InlineSourceAdapter } from "#/editor/inlineSourceEditing";
import type { WikilinkElement } from "#/editor/types";

interface ParsedWikilinkDraft {
  target: string;
  alias?: string;
}

export function parseWikilinkDraft(draft: string): ParsedWikilinkDraft | null {
  const divider = draft.indexOf("|");
  const target = divider === -1 ? draft : draft.slice(0, divider);
  const alias = divider === -1 ? undefined : draft.slice(divider + 1);
  if (target.trim().length === 0) return null;
  return alias === undefined || alias.length === 0
    ? { target }
    : { target, alias };
}

export const wikilinkSourceAdapter: InlineSourceAdapter<WikilinkElement> = {
  type: "wikilink",
  label: "Edit wikilink",
  chrome: { open: "[[", close: "]]" },
  toDraft: (element) =>
    element.alias === undefined
      ? element.target
      : `${element.target}|${element.alias}`,
  parse(draft) {
    const parsed = parseWikilinkDraft(draft);
    if (!parsed) return { kind: "cancel" };
    return {
      kind: "commit",
      apply(editor, path) {
        Transforms.setNodes(editor, { target: parsed.target }, { at: path });
        if (parsed.alias === undefined) {
          Transforms.unsetNodes(editor, "alias", { at: path });
        } else {
          Transforms.setNodes(editor, { alias: parsed.alias }, { at: path });
        }
      },
    };
  },
};
