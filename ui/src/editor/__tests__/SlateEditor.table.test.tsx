import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import {
  type Descendant,
  Editor,
  Node,
  type NodeEntry,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS, SlateEditor } from "#/editor/SlateEditor";
import type { TableElement } from "#/editor/schema/types";
import type { CustomEditor } from "#/editor/types";

// slate-react detects beforeinput support when its module loads. jsdom omits
// getTargetRanges, so expose the active DOM range before imports are evaluated.
vi.hoisted(() => {
  Object.defineProperty(InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => {
      const selection = window.getSelection();
      return selection?.rangeCount ? [selection.getRangeAt(0)] : [];
    },
  });
});

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
  Object.defineProperty(globalThis.Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Object.defineProperty(globalThis.Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([], { item: () => null }),
  });
});

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
});

function twoByTwoTable(): TableElement {
  return {
    type: "table",
    align: ["left", "right"],
    children: [
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            header: true,
            align: "left",
            children: [{ text: "Name" }],
          },
          {
            type: "table-cell",
            header: true,
            align: "right",
            children: [{ text: "Count" }],
          },
        ],
      },
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            align: "left",
            children: [{ text: "Alpha" }],
          },
          {
            type: "table-cell",
            align: "right",
            children: [{ text: "1" }],
          },
        ],
      },
    ],
  };
}

function oneColumnTable(): TableElement {
  return {
    type: "table",
    align: ["center"],
    children: [
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            header: true,
            align: "center",
            children: [{ text: "Only" }],
          },
        ],
      },
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            align: "center",
            children: [{ text: "Value" }],
          },
        ],
      },
    ],
  };
}

function oneRowTable(): TableElement {
  return {
    type: "table",
    align: ["left", "right"],
    children: [
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            header: true,
            align: "left",
            children: [{ text: "Name" }],
          },
          {
            type: "table-cell",
            header: true,
            align: "right",
            children: [{ text: "Count" }],
          },
        ],
      },
    ],
  };
}

function widerBodyTable(): TableElement {
  return {
    type: "table",
    align: ["left"],
    children: [
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            header: true,
            align: "left",
            children: [{ text: "Name" }],
          },
        ],
      },
      {
        type: "table-row",
        children: [
          {
            type: "table-cell",
            align: "left",
            children: [{ text: "Alpha" }],
          },
          { type: "table-cell", children: [{ text: "1" }] },
          { type: "table-cell", children: [{ text: "Active" }] },
        ],
      },
    ],
  };
}

function renderEditor(
  initialValue: Descendant[],
  { readOnly = false }: { readOnly?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const editorRef = createRef<CustomEditor>();
  const user = userEvent.setup();

  render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={initialValue}
        editorRef={editorRef}
        onChange={vi.fn()}
        onSaveNow={vi.fn()}
        readOnly={readOnly}
      />
      <button type="button">After editor</button>
    </QueryClientProvider>,
  );

  const editor = editorRef.current;
  if (!editor) throw new Error("Slate editor was not mounted");
  return { editor: editor as Editor, user };
}

function tableEntries(editor: Editor): NodeEntry<TableElement>[] {
  return Array.from(
    Editor.nodes(editor, {
      at: [],
      match: (node) => SlateElement.isElement(node) && node.type === "table",
    }),
  ) as NodeEntry<TableElement>[];
}

function expectCaret(editor: Editor, path: number[]) {
  expect(editor.selection?.anchor).toEqual({ path, offset: 0 });
  expect(editor.selection?.focus).toEqual({ path, offset: 0 });
}

describe("SlateEditor table slash command and affordances", () => {
  it("lists Table in the slash commands", () => {
    expect(SLASH_COMMANDS).toContainEqual(
      expect.objectContaining({ id: "table", label: "Table" }),
    );
  });

  it("inserts one empty 3-column by 3-row table and selects its first header cell", async () => {
    const { editor, user } = renderEditor([
      { type: "paragraph", children: [{ text: "" }] } as Descendant,
    ]);
    const editable = screen.getByRole("textbox");
    await user.click(editable);
    act(() => Transforms.select(editor, { path: [0, 0], offset: 0 }));

    await user.type(editable, "/table");
    const option = await screen.findByRole("option", { name: /^Table\b/i });
    fireEvent.mouseDown(option);

    await waitFor(() => {
      const entries = tableEntries(editor);
      expect(entries).toHaveLength(1);
      const [table, tablePath] = entries[0];
      expect(table.children).toHaveLength(3);
      expect(table.children.map((row) => row.type)).toEqual([
        "table-row",
        "table-row",
        "table-row",
      ]);
      expect(table.children.map((row) => row.children.length)).toEqual([
        3, 3, 3,
      ]);
      expect(
        table.children.map((row) =>
          row.children.map((cell) => cell.header === true),
        ),
      ).toEqual([
        [true, true, true],
        [false, false, false],
        [false, false, false],
      ]);
      expect(
        table.children.flatMap((row) =>
          row.children.map((cell) => Node.string(cell)),
        ),
      ).toEqual(["", "", "", "", "", "", "", "", ""]);
      expectCaret(editor, [...tablePath, 0, 0, 0]);
    });
  });

  it("appends an unaligned column and moves the caret into its first cell", async () => {
    const { editor, user } = renderEditor([twoByTwoTable()]);
    const addColumn = screen.getByRole("button", { name: "Add column" });
    expect(addColumn).toBeVisible();

    await user.click(addColumn);

    await waitFor(() => {
      const entries = tableEntries(editor);
      expect(entries).toHaveLength(1);
      const [table, tablePath] = entries[0];
      expect(table.align).toEqual(["left", "right", null]);
      expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
      expect(table.children[0].children[2]).toMatchObject({
        type: "table-cell",
        header: true,
        children: [{ text: "" }],
      });
      expect(table.children[1].children[2]).toMatchObject({
        type: "table-cell",
        children: [{ text: "" }],
      });
      expect(table.children[1].children[2].header).toBeUndefined();
      expect(table.children[0].children[2].align).toBeUndefined();
      expect(table.children[1].children[2].align).toBeUndefined();
      expectCaret(editor, [...tablePath, 0, 2, 0]);
    });

    act(() => HistoryEditor.undo(editor));
    expect(
      tableEntries(editor)[0][0].children.map((row) => row.children.length),
    ).toEqual([2, 2]);
  });

  it("appends a row matching the current columns and moves the caret into its first cell", async () => {
    const { editor, user } = renderEditor([twoByTwoTable()]);
    const addRow = screen.getByRole("button", { name: "Add row" });
    expect(addRow).toBeVisible();

    await user.click(addRow);

    await waitFor(() => {
      const entries = tableEntries(editor);
      expect(entries).toHaveLength(1);
      const [table, tablePath] = entries[0];
      expect(table.align).toEqual(["left", "right"]);
      expect(table.children).toHaveLength(3);
      const newRow = table.children[2];
      expect(newRow.type).toBe("table-row");
      expect(newRow.children).toHaveLength(2);
      expect(newRow.children.map((cell) => Node.string(cell))).toEqual([
        "",
        "",
      ]);
      expect(newRow.children.map((cell) => cell.header)).toEqual([
        undefined,
        undefined,
      ]);
      expect(newRow.children.map((cell) => cell.align)).toEqual([
        "left",
        "right",
      ]);
      expectCaret(editor, [...tablePath, 2, 0, 0]);
    });

    act(() => HistoryEditor.undo(editor));
    expect(tableEntries(editor)[0][0].children).toHaveLength(2);
  });

  it("renders keyboard-focusable delete controls with indexed accessible names", () => {
    renderEditor([twoByTwoTable()]);

    const deleteColumnOne = screen.getByRole("button", {
      name: "Delete column 1",
    });
    const deleteColumnTwo = screen.getByRole("button", {
      name: "Delete column 2",
    });
    const deleteRowOne = screen.getByRole("button", { name: "Delete row 1" });
    const deleteRowTwo = screen.getByRole("button", { name: "Delete row 2" });

    for (const control of [
      deleteColumnOne,
      deleteColumnTwo,
      deleteRowOne,
      deleteRowTwo,
    ]) {
      expect(control).toBeVisible();
      expect(control.tabIndex).toBe(0);
    }
  });

  it("normalizes a wider body row and exposes a control for every column", async () => {
    const { editor, user } = renderEditor([widerBodyTable()]);

    await waitFor(() => {
      const table = tableEntries(editor)[0][0];
      expect(table.align).toEqual(["left", null, null]);
      expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
      expect(
        screen.getByRole("button", { name: "Delete column 3" }),
      ).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Delete column 3" }));

    await waitFor(() => {
      const [table, tablePath] = tableEntries(editor)[0];
      expect(table.children.map((row) => row.children.length)).toEqual([2, 2]);
      expectCaret(editor, [...tablePath, 0, 1, 0]);
      expect(editor.selection).not.toBeNull();
      if (!editor.selection) throw new Error("Expected editor selection");
      expect(Node.has(editor, editor.selection.anchor.path)).toBe(true);
    });
  });

  it("deletes a column in one undo step and selects the nearest surviving cell", async () => {
    const { editor, user } = renderEditor([twoByTwoTable()]);

    await user.click(screen.getByRole("button", { name: "Delete column 1" }));

    await waitFor(() => {
      const [table, tablePath] = tableEntries(editor)[0];
      expect(table.align).toEqual(["right"]);
      expect(table.children.map((row) => Node.string(row))).toEqual([
        "Count",
        "1",
      ]);
      expectCaret(editor, [...tablePath, 0, 0, 0]);
    });

    act(() => HistoryEditor.undo(editor));
    const restored = tableEntries(editor)[0][0];
    expect(restored.align).toEqual(["left", "right"]);
    expect(restored.children.map((row) => Node.string(row))).toEqual([
      "NameCount",
      "Alpha1",
    ]);
  });

  it("deletes a row in one undo step and selects the nearest surviving cell", async () => {
    const { editor, user } = renderEditor([twoByTwoTable()]);

    await user.click(screen.getByRole("button", { name: "Delete row 1" }));

    await waitFor(() => {
      const [table, tablePath] = tableEntries(editor)[0];
      expect(table.align).toEqual(["left", "right"]);
      expect(table.children.map((row) => Node.string(row))).toEqual(["Alpha1"]);
      expect(table.children[0].children.map((cell) => cell.header)).toEqual([
        true,
        true,
      ]);
      expectCaret(editor, [...tablePath, 0, 0, 0]);
    });

    act(() => HistoryEditor.undo(editor));
    expect(
      tableEntries(editor)[0][0].children.map((row) => Node.string(row)),
    ).toEqual(["NameCount", "Alpha1"]);
  });

  it("removes the table at its final column and selects the following block", async () => {
    const { editor, user } = renderEditor([
      oneColumnTable(),
      { type: "paragraph", children: [{ text: "After" }] } as Descendant,
    ]);

    await user.click(screen.getByRole("button", { name: "Delete column 1" }));

    await waitFor(() => {
      expect(tableEntries(editor)).toHaveLength(0);
      expect(editor.children).toEqual([
        { type: "paragraph", children: [{ text: "After" }] },
      ]);
      expectCaret(editor, [0, 0]);
    });
  });

  it("replaces a sole table at its final column with a selected paragraph and undoes once", async () => {
    const { editor, user } = renderEditor([oneColumnTable()]);

    await user.click(screen.getByRole("button", { name: "Delete column 1" }));

    await waitFor(() => {
      expect(tableEntries(editor)).toHaveLength(0);
      expect(editor.children).toEqual([
        { type: "paragraph", children: [{ text: "" }] },
      ]);
      expectCaret(editor, [0, 0]);
    });
    act(() => HistoryEditor.undo(editor));
    expect(tableEntries(editor)).toHaveLength(1);
    expect(editor.children).toEqual([
      oneColumnTable(),
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });

  it("replaces a sole table at its final row with a selected paragraph and undoes once", async () => {
    const { editor, user } = renderEditor([oneRowTable()]);

    await user.click(screen.getByRole("button", { name: "Delete row 1" }));

    await waitFor(() => {
      expect(tableEntries(editor)).toHaveLength(0);
      expect(editor.children).toEqual([
        { type: "paragraph", children: [{ text: "" }] },
      ]);
      expectCaret(editor, [0, 0]);
    });
    act(() => HistoryEditor.undo(editor));
    expect(tableEntries(editor)).toHaveLength(1);
    expect(editor.children).toEqual([
      oneRowTable(),
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });
  it("tabs from the table through every delete and append control", async () => {
    const { editor, user } = renderEditor([twoByTwoTable()]);
    const editable = screen.getByRole("textbox");
    await user.click(editable);
    act(() => Transforms.select(editor, Editor.end(editor, [0, 1, 1])));

    for (const name of [
      "Delete column 1",
      "Delete row 1",
      "Delete column 2",
      "Delete row 2",
      "Add column",
      "Add row",
      "After editor",
    ]) {
      await user.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
  });

  it("hides table controls in read-only mode", () => {
    renderEditor([twoByTwoTable()], { readOnly: true });

    expect(screen.getByRole("table")).toBeVisible();
    for (const name of [
      "Add column",
      "Add row",
      "Delete column 1",
      "Delete column 2",
      "Delete row 1",
      "Delete row 2",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
