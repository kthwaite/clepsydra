import {
  Editor,
  type NodeEntry,
  Path,
  Point,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import type { TableCellElement } from "#/editor/types";

/**
 * Slate plugin that keeps table structure intact during editing.
 *
 * A GFM cell holds one line of phrasing content and a table's shape is
 * positional, so the default block edits are wrong here: Enter would split a
 * cell in two, and a delete across a cell boundary would merge two cells into
 * one. Both are refused; the caret moves between cells with Tab instead
 * (wired up in SlateEditor via `moveToAdjacentCell`).
 */
export function withTables(editor: Editor): Editor {
  const { insertBreak, deleteBackward, deleteForward } = editor;

  editor.insertBreak = () => {
    if (tableCellAbove(editor)) return;
    insertBreak();
  };

  editor.deleteBackward = (unit) => {
    if (atCellEdge(editor, "start")) return;
    deleteBackward(unit);
  };

  editor.deleteForward = (unit) => {
    if (atCellEdge(editor, "end") || deleteAtTableBoundary(editor)) return;
    deleteForward(unit);
  };

  return editor;
}

/** The lowest table-cell containing the selection, if any. */
function tableCellAbove(
  editor: Editor,
): NodeEntry<TableCellElement> | undefined {
  const { selection } = editor;
  if (!selection) return undefined;
  return Editor.above<TableCellElement>(editor, {
    at: selection,
    match: (n) => SlateElement.isElement(n) && n.type === "table-cell",
    mode: "lowest",
  });
}

/**
 * True when a collapsed selection sits at the given edge of a table cell —
 * the point where a delete would otherwise reach into the neighbouring cell.
 */
function atCellEdge(editor: Editor, edge: "start" | "end"): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;
  const cell = tableCellAbove(editor);
  if (!cell) return false;
  const point =
    edge === "start"
      ? Editor.start(editor, cell[1])
      : Editor.end(editor, cell[1]);
  return Point.equals(selection.anchor, point);
}

/**
 * Protect a table from Slate's default cross-block merge. At the exact
 * top-level boundary before a table, an empty block is removed and a
 * non-empty block refuses the delete.
 */
function deleteAtTableBoundary(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const blockPath = [selection.anchor.path[0]];
  if (!Point.equals(selection.anchor, Editor.end(editor, blockPath))) {
    return false;
  }

  const block = Editor.node(editor, blockPath)[0];
  if (!SlateElement.isElement(block)) return false;

  const nextPath = Path.next(blockPath);
  if (!Editor.hasPath(editor, nextPath)) return false;
  const next = Editor.node(editor, nextPath)[0];
  if (!(SlateElement.isElement(next) && next.type === "table")) return false;

  if (Editor.isEmpty(editor, block)) {
    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: blockPath });
      Transforms.select(editor, Editor.start(editor, blockPath));
    });
  }
  return true;
}

/**
 * Move the caret to the cell before/after the one holding it, wrapping across
 * row boundaries. Returns false when the selection is not in a table or there
 * is no cell in that direction, leaving the event for the next handler.
 */
export function moveToAdjacentCell(
  editor: Editor,
  direction: "next" | "previous",
): boolean {
  const cell = tableCellAbove(editor);
  if (!cell) return false;

  const target = adjacentCellPath(editor, cell[1], direction);
  if (!target) return false;

  Transforms.select(
    editor,
    direction === "next"
      ? Editor.start(editor, target)
      : Editor.end(editor, target),
  );
  return true;
}

function adjacentCellPath(
  editor: Editor,
  cellPath: Path,
  direction: "next" | "previous",
): Path | undefined {
  const rowPath = Path.parent(cellPath);
  const tablePath = Path.parent(rowPath);
  const table = Editor.node(editor, tablePath)[0];
  if (!(SlateElement.isElement(table) && table.type === "table")) {
    return undefined;
  }

  const rowIndex = rowPath[rowPath.length - 1];
  const cellIndex = cellPath[cellPath.length - 1];
  const row = table.children[rowIndex];

  if (direction === "next") {
    if (cellIndex + 1 < row.children.length) {
      return [...rowPath, cellIndex + 1];
    }
    const nextRow = table.children[rowIndex + 1];
    if (!nextRow || nextRow.children.length === 0) return undefined;
    return [...tablePath, rowIndex + 1, 0];
  }

  if (cellIndex > 0) return [...rowPath, cellIndex - 1];
  const previousRow = table.children[rowIndex - 1];
  if (!previousRow || previousRow.children.length === 0) return undefined;
  return [...tablePath, rowIndex - 1, previousRow.children.length - 1];
}
