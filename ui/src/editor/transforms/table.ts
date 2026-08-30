import { Editor, Node, type Path, Transforms } from "slate";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import {
  makeTable,
  makeTableCell,
  makeTableRow,
} from "#/editor/schema/elements/table";
import type { TableElement } from "#/editor/schema/types";

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
