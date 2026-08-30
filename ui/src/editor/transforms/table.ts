import { Editor, Node, type Path, Transforms } from "slate";
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
