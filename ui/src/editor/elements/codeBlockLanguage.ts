import { type Editor, type Path, Transforms } from "slate";

/**
 * Set the language of the code-block at `path`, or clear it when `lang` is
 * null. Passing `language: undefined` to `setNodes` removes the property, so a
 * cleared block falls back to plain text (no highlighting) in `decorateCode`.
 */
export function setCodeBlockLanguage(
  editor: Editor,
  path: Path,
  lang: string | null,
): void {
  Transforms.setNodes(editor, { language: lang ?? undefined }, { at: path });
}
