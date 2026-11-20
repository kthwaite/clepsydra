import { Editor, Node, type Path, Transforms } from "slate";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import {
  makeTable,
  makeTableCell,
  makeTableRow,
} from "#/editor/schema/elements/table";
import type {
  TableAlign,
  TableCellElement,
  TableElement,
  TableRowElement,
} from "#/editor/schema/types";

export interface CreateTableGridOptions {
  columns: number;
  rows: number;
}

export function createTableGrid({
  columns,
  rows,
}: CreateTableGridOptions): TableElement {
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    !Number.isInteger(rows) ||
    rows < 1
  ) {
    throw new RangeError("Table dimensions must be positive integers");
  }

  return makeTable({
    children: Array.from({ length: rows }, (_, rowIndex) =>
      makeTableRow({
        children: Array.from({ length: columns }, () =>
          makeTableCell(rowIndex === 0 ? { header: true } : {}),
        ),
      }),
    ),
  });
}

export function appendTableColumn(editor: Editor, tablePath: Path): Path {
  const table = Node.get(editor, tablePath) as TableElement;
  const columnIndex = Math.max(
    ...table.children.map((row) => row.children.length),
  );
  const columnAlign = Array.from(
    { length: columnIndex },
    (_, index) => table.align?.[index] ?? null,
  );
  const firstNewCellPath = [...tablePath, 0, columnIndex];

  Editor.withoutNormalizing(editor, () => {
    Transforms.setNodes(
      editor,
      { align: [...columnAlign, null] } as Partial<TableElement>,
      { at: tablePath },
    );

    table.children.forEach((row, rowIndex) => {
      for (
        let cellIndex = row.children.length;
        cellIndex < columnIndex;
        cellIndex++
      ) {
        const align = columnAlign[cellIndex];
        Transforms.insertNodes(
          editor,
          makeTableCell({
            ...(rowIndex === 0 ? { header: true as const } : {}),
            ...(align ? { align } : {}),
          }),
          { at: [...tablePath, rowIndex, cellIndex] },
        );
      }

      Transforms.insertNodes(
        editor,
        makeTableCell(rowIndex === 0 ? { header: true } : {}),
        { at: [...tablePath, rowIndex, columnIndex] },
      );
    });
  });

  return firstNewCellPath;
}

export function appendTableRow(editor: Editor, tablePath: Path): Path {
  const table = Node.get(editor, tablePath) as TableElement;
  const rowIndex = table.children.length;
  const columnCount = table.children[0].children.length;
  const row = makeTableRow({
    children: Array.from({ length: columnCount }, (_, columnIndex) => {
      const align = table.align?.[columnIndex];
      return makeTableCell(align ? { align } : {});
    }),
  });

  Editor.withoutNormalizing(editor, () => {
    Transforms.insertNodes(editor, row, { at: [...tablePath, rowIndex] });
  });

  return [...tablePath, rowIndex, 0];
}

function removeTable(editor: Editor, tablePath: Path): Path {
  let nearestPath = tablePath;

  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: tablePath });
    if (Node.has(editor, tablePath)) return;

    const previousPath = [...tablePath];
    previousPath[previousPath.length - 1] -= 1;
    const previousIndex = previousPath.at(-1);
    if (
      previousIndex !== undefined &&
      previousIndex >= 0 &&
      Node.has(editor, previousPath)
    ) {
      nearestPath = previousPath;
      return;
    }

    Transforms.insertNodes(editor, makeParagraph({}), { at: tablePath });
  });

  return nearestPath;
}

export function deleteTableColumn(
  editor: Editor,
  tablePath: Path,
  columnIndex: number,
): Path | null {
  const table = Node.get(editor, tablePath) as TableElement;
  const columnCount = Math.max(
    ...table.children.map((row) => row.children.length),
  );

  if (columnCount === 1) {
    return removeTable(editor, tablePath);
  }

  const align = Array.from(
    { length: columnCount },
    (_, index) => table.align?.[index] ?? null,
  );
  align.splice(columnIndex, 1);

  Editor.withoutNormalizing(editor, () => {
    Transforms.setNodes(editor, { align } as Partial<TableElement>, {
      at: tablePath,
    });
    table.children.forEach((row, rowIndex) => {
      if (columnIndex < row.children.length) {
        Transforms.removeNodes(editor, {
          at: [...tablePath, rowIndex, columnIndex],
        });
      }
    });
  });

  return [...tablePath, 0, Math.min(columnIndex, columnCount - 2)];
}

export function deleteTableRow(
  editor: Editor,
  tablePath: Path,
  rowIndex: number,
): Path | null {
  const table = Node.get(editor, tablePath) as TableElement;

  if (table.children.length === 1) {
    return removeTable(editor, tablePath);
  }

  Transforms.removeNodes(editor, { at: [...tablePath, rowIndex] });
  return [...tablePath, Math.min(rowIndex, table.children.length - 2), 0];
}

// ---------------------------------------------------------------------------
// Structural edits by index
//
// These assume a rectangular table, which the table's normalize rule
// guarantees for anything the editor has rendered. Each returns the path of
// the cell the caret should land in, or null when nothing changed.
// ---------------------------------------------------------------------------

function tableAt(editor: Editor, tablePath: Path): TableElement {
  return Node.get(editor, tablePath) as TableElement;
}

function columnCountOf(table: TableElement): number {
  return Math.max(...table.children.map((row) => row.children.length));
}

function alignOf(table: TableElement): (TableAlign | null)[] {
  return Array.from(
    { length: columnCountOf(table) },
    (_, index) => table.align?.[index] ?? null,
  );
}

function setAlign(
  editor: Editor,
  tablePath: Path,
  align: (TableAlign | null)[],
): void {
  Transforms.setNodes(editor, { align } as Partial<TableElement>, {
    at: tablePath,
  });
}

/** Insert an empty, unaligned column so that it becomes column `columnIndex`. */
export function insertTableColumn(
  editor: Editor,
  tablePath: Path,
  columnIndex: number,
): Path {
  const table = tableAt(editor, tablePath);
  const align = alignOf(table);
  const index = Math.max(0, Math.min(columnIndex, align.length));
  if (index === align.length) return appendTableColumn(editor, tablePath);

  align.splice(index, 0, null);
  Editor.withoutNormalizing(editor, () => {
    setAlign(editor, tablePath, align);
    table.children.forEach((_, rowIndex) => {
      Transforms.insertNodes(
        editor,
        makeTableCell(rowIndex === 0 ? { header: true } : {}),
        { at: [...tablePath, rowIndex, index] },
      );
    });
  });
  return [...tablePath, 0, index];
}

/**
 * Insert an empty body row so that it becomes row `rowIndex`. The header row
 * is positional, so nothing can be inserted above it: the index is clamped
 * to 1.
 */
export function insertTableRow(
  editor: Editor,
  tablePath: Path,
  rowIndex: number,
): Path {
  const table = tableAt(editor, tablePath);
  const index = Math.max(1, Math.min(rowIndex, table.children.length));
  const align = alignOf(table);
  const row = makeTableRow({
    children: align.map((columnAlign) =>
      makeTableCell(columnAlign ? { align: columnAlign } : {}),
    ),
  });
  Transforms.insertNodes(editor, row, { at: [...tablePath, index] });
  return [...tablePath, index, 0];
}

/** Move column `from` so that it becomes column `to`. */
export function moveTableColumn(
  editor: Editor,
  tablePath: Path,
  from: number,
  to: number,
): Path | null {
  const table = tableAt(editor, tablePath);
  const align = alignOf(table);
  const inRange = (index: number) => index >= 0 && index < align.length;
  if (from === to || !inRange(from) || !inRange(to)) return null;

  const [moved] = align.splice(from, 1);
  align.splice(to, 0, moved);
  Editor.withoutNormalizing(editor, () => {
    setAlign(editor, tablePath, align);
    table.children.forEach((_, rowIndex) => {
      Transforms.moveNodes(editor, {
        at: [...tablePath, rowIndex, from],
        to: [...tablePath, rowIndex, to],
      });
    });
  });
  return [...tablePath, 0, to];
}

/**
 * Move body row `from` so that it becomes row `to`. The header row neither
 * moves nor is displaced.
 */
export function moveTableRow(
  editor: Editor,
  tablePath: Path,
  from: number,
  to: number,
): Path | null {
  const table = tableAt(editor, tablePath);
  const inRange = (index: number) =>
    index >= 1 && index < table.children.length;
  if (from === to || !inRange(from) || !inRange(to)) return null;

  Transforms.moveNodes(editor, {
    at: [...tablePath, from],
    to: [...tablePath, to],
  });
  return [...tablePath, to, 0];
}

/** Copy column `columnIndex` and insert the copy to its right. */
export function duplicateTableColumn(
  editor: Editor,
  tablePath: Path,
  columnIndex: number,
): Path | null {
  const table = tableAt(editor, tablePath);
  const align = alignOf(table);
  if (columnIndex < 0 || columnIndex >= align.length) return null;

  align.splice(columnIndex + 1, 0, align[columnIndex]);
  Editor.withoutNormalizing(editor, () => {
    setAlign(editor, tablePath, align);
    table.children.forEach((row, rowIndex) => {
      Transforms.insertNodes(
        editor,
        structuredClone(row.children[columnIndex]),
        {
          at: [...tablePath, rowIndex, columnIndex + 1],
        },
      );
    });
  });
  return [...tablePath, 0, columnIndex + 1];
}

/**
 * Copy row `rowIndex` and insert the copy below it. A copy of the header row
 * lands as the first body row; normalize clears its header flags.
 */
export function duplicateTableRow(
  editor: Editor,
  tablePath: Path,
  rowIndex: number,
): Path | null {
  const table = tableAt(editor, tablePath);
  const row = table.children[rowIndex];
  if (!row) return null;

  const copy = makeTableRow({
    children: row.children.map((cell) => {
      const { header: _header, ...rest } = structuredClone(cell);
      return rest;
    }),
  });
  Transforms.insertNodes(editor, copy, { at: [...tablePath, rowIndex + 1] });
  return [...tablePath, rowIndex + 1, 0];
}

/** Set (or with `null`, clear) a column's delimiter-row alignment. */
export function setTableColumnAlign(
  editor: Editor,
  tablePath: Path,
  columnIndex: number,
  columnAlign: TableAlign | null,
): void {
  const table = tableAt(editor, tablePath);
  const align = alignOf(table);
  if (columnIndex < 0 || columnIndex >= align.length) return;
  align[columnIndex] = columnAlign;

  Editor.withoutNormalizing(editor, () => {
    setAlign(editor, tablePath, align);
    table.children.forEach((row, rowIndex) => {
      if (columnIndex >= row.children.length) return;
      Transforms.setNodes(
        editor,
        { align: columnAlign ?? undefined } as Partial<TableCellElement>,
        { at: [...tablePath, rowIndex, columnIndex] },
      );
    });
  });
}

const CELL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Sort the body rows by the plain text of one column. The sort is stable,
 * numeric-aware ("2" before "10"), and keeps empty cells last in either
 * direction. Returns false when the rows were already in order.
 */
export function sortTableByColumn(
  editor: Editor,
  tablePath: Path,
  columnIndex: number,
  direction: "ascending" | "descending",
): boolean {
  const table = tableAt(editor, tablePath);
  const body = table.children.slice(1);
  const key = (row: TableRowElement) => {
    const cell = row.children[columnIndex];
    return cell ? Node.string(cell).trim() : "";
  };
  const sign = direction === "ascending" ? 1 : -1;
  const sorted = [...body].sort((a, b) => {
    const [left, right] = [key(a), key(b)];
    if (left === "" || right === "") {
      return Number(left === "") - Number(right === "");
    }
    return sign * CELL_COLLATOR.compare(left, right);
  });
  if (sorted.every((row, index) => row === body[index])) return false;

  // Settle each position in turn; `order` tracks where the rows sit now.
  const order = [...body];
  Editor.withoutNormalizing(editor, () => {
    sorted.forEach((row, target) => {
      const current = order.indexOf(row);
      if (current === target) return;
      Transforms.moveNodes(editor, {
        at: [...tablePath, current + 1],
        to: [...tablePath, target + 1],
      });
      order.splice(current, 1);
      order.splice(target, 0, row);
    });
  });
  return true;
}

/**
 * Where a dragged column or row would land: the index of the item whose box
 * holds the pointer, counting the pointer as "past" an item once it crosses
 * that item's midpoint. `extents` are the items' [start, end) spans along the
 * drag axis, in order. The result is an insertion boundary in 0..=length.
 */
export function dropBoundary(
  extents: readonly (readonly [number, number])[],
  pointer: number,
): number {
  let boundary = 0;
  for (const [start, end] of extents) {
    if (pointer < (start + end) / 2) break;
    boundary += 1;
  }
  return boundary;
}

/**
 * Convert an insertion boundary into the destination index for a move:
 * dropping on either side of the item itself leaves it where it is.
 */
export function moveTarget(from: number, boundary: number): number {
  return boundary > from ? boundary - 1 : boundary;
}
