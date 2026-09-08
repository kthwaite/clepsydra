import {
  Editor,
  type Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { getDescriptor } from "#/editor/schema/registry";
import { caretAtBlockEdge, type EscapeSide } from "./blockEscape";

/**
 * From the edge line of a code block or the edge row of a table, select the
 * neighbouring top-level void block (divider, time heading, …) on `side`.
 * Arrow keys inside those blocks otherwise stay within the block, so the void
 * neighbour is unreachable. Paragraphs and headings are left to native caret
 * movement, which already reaches the void's spacer.
 *
 * Returns true when the neighbour was selected.
 */
export function selectAdjacentVoidBlock(
  editor: Editor,
  side: EscapeSide,
): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const topPath: Path = [selection.anchor.path[0]];
  if (!Editor.hasPath(editor, topPath)) return false;
  const [block] = Editor.node(editor, topPath);
  if (!SlateElement.isElement(block)) return false;
  if (block.type !== "code-block" && block.type !== "table") return false;
  if (!caretAtBlockEdge(editor, block, topPath, side)) return false;

  const neighbourPath: Path = [topPath[0] + (side === "above" ? -1 : 1)];
  if (!Editor.hasPath(editor, neighbourPath)) return false;
  const [neighbour] = Editor.node(editor, neighbourPath);
  if (!SlateElement.isElement(neighbour)) return false;
  if (getDescriptor(neighbour.type)?.kind !== "void-block") return false;

  Transforms.select(editor, Editor.start(editor, neighbourPath));
  return true;
}
