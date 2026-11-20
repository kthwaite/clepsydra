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

type User = ReturnType<typeof userEvent.setup>;

/** Open a column or row grip's menu and choose one of its items. */
async function chooseFromGrip(user: User, grip: string, item: string) {
  await user.click(screen.getByRole("button", { name: grip }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

function cellText(editor: Editor): string[][] {
  return tableEntries(editor)[0][0].children.map((row) =>
    row.children.map((cell) => Node.string(cell)),
  );
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

  it("renders a keyboard-focusable grip for every column and row", () => {
    renderEditor([twoByTwoTable()]);

    for (const name of [
      "Column 1 options",
      "Column 2 options",
      "Row 1 options",
      "Row 2 options",
    ]) {
      const grip = screen.getByRole("button", { name });
      expect(grip.tabIndex).toBe(0);
      expect(grip).toHaveAttribute("aria-haspopup", "menu");
    }
  });

  it("reveals only the hovered cell's column and row grips", async () => {
    const { user } = renderEditor([twoByTwoTable()]);
    const hidden = (name: string) =>
      screen.getByRole("button", { name }).className.includes("opacity-0");

    expect(
      [
        "Column 1 options",
        "Column 2 options",
        "Row 1 options",
        "Row 2 options",
      ].map(hidden),
    ).toEqual([true, true, true, true]);

    await user.hover(screen.getByRole("cell", { name: "1" }));

    expect(hidden("Column 2 options")).toBe(false);
    expect(hidden("Row 2 options")).toBe(false);
    expect(hidden("Column 1 options")).toBe(true);
    expect(hidden("Row 1 options")).toBe(true);

    await user.unhover(screen.getByRole("table"));
    await user.hover(screen.getByRole("button", { name: "After editor" }));
    expect(hidden("Column 2 options")).toBe(true);
    expect(hidden("Row 2 options")).toBe(true);
  });

  it("keeps a grip shown and its column tinted while its menu is open", async () => {
    const { user } = renderEditor([twoByTwoTable()]);
    const grip = screen.getByRole("button", { name: "Column 2 options" });

    await user.click(grip);
    await screen.findByRole("menu", { name: "Column 2" });

    expect(grip).toHaveAttribute("aria-expanded", "true");
    expect(grip.className).not.toContain("opacity-0");
    // The open menu hides the rest of the page from the accessibility tree.
    expect(screen.getByText("Count").closest("th")?.className).toContain(
      "bg-accent-tint",
    );
    expect(screen.getByText("Name").closest("th")?.className).not.toContain(
      "bg-accent-tint",
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("normalizes a wider body row and exposes a control for every column", async () => {
    const { editor, user } = renderEditor([widerBodyTable()]);

    await waitFor(() => {
      const table = tableEntries(editor)[0][0];
      expect(table.align).toEqual(["left", null, null]);
      expect(table.children.map((row) => row.children.length)).toEqual([3, 3]);
      expect(
        screen.getByRole("button", { name: "Column 3 options" }),
      ).toBeVisible();
    });

    await chooseFromGrip(user, "Column 3 options", "Delete column");

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

    await chooseFromGrip(user, "Column 1 options", "Delete column");

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

    await chooseFromGrip(user, "Row 1 options", "Delete row");

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

    await chooseFromGrip(user, "Column 1 options", "Delete column");

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

    await chooseFromGrip(user, "Column 1 options", "Delete column");

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

    await chooseFromGrip(user, "Row 1 options", "Delete row");

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
  it("tabs from the table through every grip and append control", async () => {
    const { editor, user } = renderEditor([twoByTwoTable()]);
    const editable = screen.getByRole("textbox");
    await user.click(editable);
    act(() => Transforms.select(editor, Editor.end(editor, [0, 1, 1])));

    for (const name of [
      "Column 1 options",
      "Row 1 options",
      "Column 2 options",
      "Row 2 options",
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
      "Column 1 options",
      "Column 2 options",
      "Row 1 options",
      "Row 2 options",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

function threeByThreeTable(): TableElement {
  const row = (header: boolean, ...cells: string[]) => ({
    type: "table-row" as const,
    children: cells.map((text) => ({
      type: "table-cell" as const,
      ...(header ? { header: true as const } : {}),
      children: [{ text }],
    })),
  });
  return {
    type: "table",
    align: [null, null, null],
    children: [
      row(true, "Name", "Count", "Note"),
      row(false, "Beta", "10", "x"),
      row(false, "Alpha", "2", "y"),
    ],
  };
}

describe("SlateEditor table menus", () => {
  it("adds a column before the grip's column in one undo step", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    await chooseFromGrip(user, "Column 2 options", "Add column before");

    await waitFor(() => {
      expect(cellText(editor)).toEqual([
        ["Name", "", "Count", "Note"],
        ["Beta", "", "10", "x"],
        ["Alpha", "", "2", "y"],
      ]);
      expectCaret(editor, [0, 0, 1, 0]);
    });
    expect(screen.queryByRole("menu")).toBeNull();

    act(() => HistoryEditor.undo(editor));
    expect(cellText(editor)[0]).toEqual(["Name", "Count", "Note"]);
  });

  it("adds a row below the grip's row", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    await chooseFromGrip(user, "Row 2 options", "Add row below");

    await waitFor(() => {
      expect(cellText(editor).map((row) => row[0])).toEqual([
        "Name",
        "Beta",
        "",
        "Alpha",
      ]);
      expectCaret(editor, [0, 2, 0, 0]);
    });
  });

  it("moves a column and a row from their menus", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    await chooseFromGrip(user, "Column 1 options", "Move column right");
    await waitFor(() =>
      expect(cellText(editor)[0]).toEqual(["Count", "Name", "Note"]),
    );

    await chooseFromGrip(user, "Row 3 options", "Move row up");
    await waitFor(() =>
      expect(cellText(editor).map((row) => row[1])).toEqual([
        "Name",
        "Alpha",
        "Beta",
      ]),
    );
  });

  it("re-homes the grips after a move, so each sits on the cell now at the edge", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);
    const gripsIn = (cell: HTMLElement | null | undefined) =>
      Array.from(cell?.querySelectorAll("[data-table-grip]") ?? [], (grip) =>
        grip.getAttribute("aria-label"),
      );

    await chooseFromGrip(user, "Column 1 options", "Move column right");
    await waitFor(() =>
      expect(cellText(editor)[0]).toEqual(["Count", "Name", "Note"]),
    );

    // Slate does not re-render a cell whose node only moved; the grips must
    // follow the layout anyway.
    await waitFor(() => {
      expect(gripsIn(screen.getByText("Count").closest("th"))).toEqual([
        "Column 1 options",
        "Row 1 options",
      ]);
      expect(gripsIn(screen.getByText("Name").closest("th"))).toEqual([
        "Column 2 options",
      ]);
      expect(gripsIn(screen.getByText("10").closest("td"))).toEqual([
        "Row 2 options",
      ]);
      expect(gripsIn(screen.getByText("Beta").closest("td"))).toEqual([]);
    });
  });

  it("pins the header row and disables moves past either end", async () => {
    const { user } = renderEditor([threeByThreeTable()]);
    const disabled = (name: string) =>
      screen.getByRole("menuitem", { name }).getAttribute("aria-disabled");

    await user.click(screen.getByRole("button", { name: "Row 1 options" }));
    await screen.findByRole("menu", { name: "Row 1" });
    expect(disabled("Add row above")).toBe("true");
    expect(disabled("Move row up")).toBe("true");
    expect(disabled("Move row down")).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Row 2 options" }));
    await screen.findByRole("menu", { name: "Row 2" });
    expect(disabled("Move row up")).toBe("true");
    expect(disabled("Move row down")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Column 3 options" }));
    await screen.findByRole("menu", { name: "Column 3" });
    expect(disabled("Move column right")).toBe("true");
    expect(disabled("Move column left")).toBeNull();
  });

  it("sorts the body rows by a column, numerically", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    await chooseFromGrip(user, "Column 2 options", "Sort by column (A to Z)");
    await waitFor(() =>
      expect(cellText(editor).map((row) => row[1])).toEqual([
        "Count",
        "2",
        "10",
      ]),
    );

    act(() => HistoryEditor.undo(editor));
    expect(cellText(editor).map((row) => row[1])).toEqual(["Count", "10", "2"]);
  });

  it("sets a column's alignment, shows it checked, and clears it on a second choice", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);
    const grip = screen.getByRole("button", { name: "Column 2 options" });

    await user.click(grip);
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Align right" }),
    );
    await waitFor(() =>
      expect(tableEntries(editor)[0][0].align).toEqual([null, "right", null]),
    );
    expect(screen.getByRole("cell", { name: "10" }).className).toContain(
      "text-right",
    );

    await user.click(grip);
    const checked = await screen.findByRole("menuitemradio", {
      name: "Align right",
    });
    expect(checked).toHaveAttribute("aria-checked", "true");
    await user.click(checked);
    await waitFor(() =>
      expect(tableEntries(editor)[0][0].align).toEqual([null, null, null]),
    );
  });

  it("duplicates a column and a row", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    await chooseFromGrip(user, "Column 1 options", "Duplicate column");
    await waitFor(() =>
      expect(cellText(editor)[1]).toEqual(["Beta", "Beta", "10", "x"]),
    );

    await chooseFromGrip(user, "Row 2 options", "Duplicate row");
    await waitFor(() =>
      expect(cellText(editor).map((row) => row[0])).toEqual([
        "Name",
        "Beta",
        "Beta",
        "Alpha",
      ]),
    );
  });

  it("opens a cell menu on right-click that acts on that cell's row and column", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    fireEvent.contextMenu(screen.getByRole("cell", { name: "2" }), {
      clientX: 40,
      clientY: 40,
    });
    await screen.findByRole("menu", { name: "Table" });
    await user.click(screen.getByRole("menuitem", { name: "Add row above" }));
    await waitFor(() =>
      expect(cellText(editor).map((row) => row[0])).toEqual([
        "Name",
        "Beta",
        "",
        "Alpha",
      ]),
    );

    fireEvent.contextMenu(screen.getByRole("cell", { name: "10" }), {
      clientX: 40,
      clientY: 40,
    });
    await screen.findByRole("menu", { name: "Table" });
    await user.click(screen.getByRole("menuitem", { name: "Delete column" }));
    await waitFor(() => expect(cellText(editor)[0]).toEqual(["Name", "Note"]));
  });

  it("reaches the row and column submenus from the cell menu", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    fireEvent.contextMenu(screen.getByRole("cell", { name: "Alpha" }), {
      clientX: 40,
      clientY: 40,
    });
    await screen.findByRole("menu", { name: "Table" });
    await user.click(screen.getByRole("menuitem", { name: "Row" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Move row up" }),
    );

    await waitFor(() =>
      expect(cellText(editor).map((row) => row[0])).toEqual([
        "Name",
        "Alpha",
        "Beta",
      ]),
    );
  });

  it("leaves the browser's menu alone over selected text", () => {
    const { editor } = renderEditor([threeByThreeTable()]);
    act(() =>
      Transforms.select(editor, {
        anchor: { path: [0, 1, 0, 0], offset: 0 },
        focus: { path: [0, 1, 0, 0], offset: 4 },
      }),
    );

    const allowed = fireEvent.contextMenu(
      screen.getByRole("cell", { name: "Beta" }),
    );

    expect(allowed).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the grip's own menu when the grip is right-clicked", async () => {
    renderEditor([threeByThreeTable()]);

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Row 2 options" }),
    );

    expect(await screen.findByRole("menu", { name: "Row 2" })).toBeVisible();
  });

  it("moves a column and a row with Alt+Arrow on the grip and keeps the grip focused", async () => {
    const { editor, user } = renderEditor([threeByThreeTable()]);

    const columnGrip = screen.getByRole("button", { name: "Column 1 options" });
    act(() => columnGrip.focus());
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await waitFor(() => {
      expect(cellText(editor)[0]).toEqual(["Count", "Name", "Note"]);
      expect(
        screen.getByRole("button", { name: "Column 2 options" }),
      ).toHaveFocus();
    });

    const rowGrip = screen.getByRole("button", { name: "Row 2 options" });
    act(() => rowGrip.focus());
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => {
      expect(cellText(editor).map((row) => row[1])).toEqual([
        "Name",
        "Alpha",
        "Beta",
      ]);
      expect(
        screen.getByRole("button", { name: "Row 3 options" }),
      ).toHaveFocus();
    });

    // The header row stays put.
    const headerGrip = screen.getByRole("button", { name: "Row 1 options" });
    act(() => headerGrip.focus());
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(cellText(editor).map((row) => row[1])[0]).toBe("Name");
  });
});
