import {
  createEditor,
  type Editor,
  Node,
  Element as SlateElement,
} from "slate";
import { describe, expect, it } from "vitest";
import { withTables } from "#/editor/plugins/withTables";
import {
  makeTable,
  makeTableCell,
  makeTableRow,
} from "#/editor/schema/elements/table";
import type { TableElement } from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";
import { appendTableColumn, appendTableRow, createTableGrid } from "../table";

function alignedTable(): TableElement {
  return makeTable({
    align: ["left", "right"],
    children: [
      makeTableRow({
        children: [
          makeTableCell({
            header: true,
            align: "left",
            children: [{ text: "A" }],
          }),
          makeTableCell({
            header: true,
            align: "right",
            children: [{ text: "B" }],
          }),
        ],
      }),
      makeTableRow({
        children: [
          makeTableCell({ align: "left", children: [{ text: "1" }] }),
          makeTableCell({ align: "right", children: [{ text: "2" }] }),
        ],
      }),
    ],
  });
}

function editorWithTable() {
  const editor = withTables(withSchema(createEditor()));
  editor.children = [alignedTable()];
  return editor;
}

function firstTable(editor: Editor): TableElement {
  const node = editor.children[0];
  if (!SlateElement.isElement(node) || node.type !== "table") {
    throw new Error("Expected the editor's first node to be a table");
  }
  return node;
}

describe("table transforms", () => {
  it("creates a 3x3 grid with a header row and empty cells", () => {
    const table = createTableGrid({ columns: 3, rows: 3 });

    expect(table.type).toBe("table");
    expect(table.children.map((row) => row.type)).toEqual([
      "table-row",
      "table-row",
      "table-row",
    ]);
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3, 3]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.type)),
    ).toEqual([
      ["table-cell", "table-cell", "table-cell"],
      ["table-cell", "table-cell", "table-cell"],
      ["table-cell", "table-cell", "table-cell"],
    ]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.header)),
    ).toEqual([
      [true, true, true],
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ]);
    expect(
      table.children.flatMap((row) =>
        row.children.map((cell) => cell.children),
      ),
    ).toEqual(Array.from({ length: 9 }, () => [{ text: "" }]));
  });

  it("appends an unaligned column to every row and returns its first cell path", () => {
    const editor = editorWithTable();

    const firstNewCellPath = appendTableColumn(editor, [0]);
    const table = firstTable(editor);

    expect(firstNewCellPath).toEqual([0, 0, 2]);
    expect(Node.get(editor, firstNewCellPath)).toBe(
      table.children[0].children[2],
    );
    expect(table.align).toEqual(["left", "right", null]);
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.align)),
    ).toEqual([
      ["left", "right", undefined],
      ["left", "right", undefined],
    ]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.header)),
    ).toEqual([
      [true, true, true],
      [undefined, undefined, undefined],
    ]);
    expect(table.children.map((row) => Node.string(row))).toEqual(["AB", "12"]);
    expect(table.children.map((row) => row.children[2].children)).toEqual([
      [{ text: "" }],
      [{ text: "" }],
    ]);
  });

  it("repairs ragged rows and stale alignment before appending a column", () => {
    const editor = withTables(withSchema(createEditor()));
    editor.children = [
      makeTable({
        align: ["left", "right", "center"],
        children: [
          makeTableRow({
            children: [
              makeTableCell({ header: true, children: [{ text: "A" }] }),
              makeTableCell({ header: true, children: [{ text: "B" }] }),
            ],
          }),
          makeTableRow({
            children: [makeTableCell({ children: [{ text: "1" }] })],
          }),
        ],
      }),
    ];

    expect(appendTableColumn(editor, [0])).toEqual([0, 0, 2]);
    const table = firstTable(editor);

    expect(table.align).toEqual(["left", "right", null]);
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
    expect(
      table.children.map((row) => row.children.map((cell) => cell.align)),
    ).toEqual([
      ["left", "right", undefined],
      ["left", "right", undefined],
    ]);
  });

  it("appends a matching-width body row and returns its first cell path", () => {
    const editor = editorWithTable();

    const firstNewCellPath = appendTableRow(editor, [0]);
    const table = firstTable(editor);
    const newRow = table.children[2];

    expect(firstNewCellPath).toEqual([0, 2, 0]);
    expect(Node.get(editor, firstNewCellPath)).toBe(newRow.children[0]);
    expect(newRow.type).toBe("table-row");
    expect(newRow.children).toEqual([
      {
        type: "table-cell",
        align: "left",
        children: [{ text: "" }],
      },
      {
        type: "table-cell",
        align: "right",
        children: [{ text: "" }],
      },
    ]);
    expect(table.children.map((row) => row.children.length)).toEqual([2, 2, 2]);
    expect(table.children.slice(0, 2).map((row) => Node.string(row))).toEqual([
      "AB",
      "12",
    ]);
  });
});
