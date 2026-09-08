import {
  Editor,
  type Node,
  type Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import { getDescriptor } from "#/editor/schema/registry";

export type EscapeSide = "above" | "below";

/**
 * A trapping block is one the caret cannot leave with a plain arrow key when
 * the block opens or closes the document: void blocks (divider, time heading,
 * math block, embed), code blocks (arrows move within the text) and tables
 * (arrows move between cells).
 */
export function isTrappingBlock(node: Node): boolean {
  if (!SlateElement.isElement(node)) return false;
  if (node.type === "code-block" || node.type === "table") return true;
  return getDescriptor(node.type)?.kind === "void-block";
}

/**
 * If the collapsed caret sits at the outer edge of a trapping block that is
 * the document's first (`above`) or last (`below`) top-level block, insert an
 * empty paragraph on that side and move the caret into it.
 *
 * Returns true when a paragraph was inserted.
 */
export function escapeTrappingBlock(editor: Editor, side: EscapeSide): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const topPath: Path = [selection.anchor.path[0]];
  if (!Editor.hasPath(editor, topPath)) return false;
  const [block] = Editor.node(editor, topPath);
  if (!isTrappingBlock(block)) return false;

  const lastIndex = editor.children.length - 1;
  const atDocumentEdge =
    side === "above" ? topPath[0] === 0 : topPath[0] === lastIndex;
  if (!atDocumentEdge) return false;
  if (!caretAtBlockEdge(editor, block, topPath, side)) return false;

  const at: Path = side === "above" ? [0] : [editor.children.length];
  Transforms.insertNodes(editor, makeParagraph({}), { at });
  Transforms.select(editor, Editor.start(editor, at));
  return true;
}

function caretAtBlockEdge(
  editor: Editor,
  block: Node,
  blockPath: Path,
  side: EscapeSide,
): boolean {
  if (!SlateElement.isElement(block) || !editor.selection) return false;
  const caret = editor.selection.anchor;

  if (block.type === "code-block") {
    const edge =
      side === "above"
        ? Editor.start(editor, blockPath)
        : Editor.end(editor, blockPath);
    const between = Editor.string(editor, {
      anchor: side === "above" ? edge : caret,
      focus: side === "above" ? caret : edge,
    });
    return !between.includes("\n");
  }

  if (block.type === "table") {
    const rowIndex = caret.path[blockPath.length];
    const lastRow = block.children.length - 1;
    return side === "above" ? rowIndex === 0 : rowIndex === lastRow;
  }

  // Void block: the caret has nowhere else to be.
  return true;
}
