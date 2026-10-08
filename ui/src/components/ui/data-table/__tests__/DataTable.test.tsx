import type {
  draggable as draggableAdapter,
  dropTargetForElements as dropTargetForElementsAdapter,
  ElementDragPayload,
  ElementDropTargetEventPayloadMap,
  ElementDropTargetGetFeedbackArgs,
  ElementEventPayloadMap,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { attachClosestEdge as attachClosestEdgeAdapter } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DataColumn,
  DataTable,
  type DataTableProps,
  type RowSelectionState,
} from "#/components/ui/data-table";

// --- jsdom DnD harness (after Sheaf.test.tsx): the adapter is mocked so the
// test captures each registration and dispatches its callbacks directly.
type DraggableRegistration = Parameters<typeof draggableAdapter>[0];
type DropTargetRegistration = Parameters<
  typeof dropTargetForElementsAdapter
>[0];
type AttachClosestEdge = typeof attachClosestEdgeAdapter;
type ClosestEdge = "left" | "right";
type DropPayload = ElementDropTargetEventPayloadMap["onDrop"];
type DropTargetRecord = DropPayload["self"];
type DragSource = {
  registration: DraggableRegistration;
  source: ElementDragPayload;
};

const dnd = vi.hoisted(() => ({
  draggables: [] as DraggableRegistration[],
  dropTargets: [] as DropTargetRegistration[],
  closestEdge: "left" as ClosestEdge,
  closestEdgeKey: Symbol("closest-edge"),
}));

function register<T>(registrations: T[], registration: T) {
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index !== -1) registrations.splice(index, 1);
  };
}

vi.mock("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: (registration: DraggableRegistration) =>
    register(dnd.draggables, registration),
  dropTargetForElements: (registration: DropTargetRegistration) =>
    register(dnd.dropTargets, registration),
  monitorForElements: () => () => {},
}));

vi.mock("@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge", () => ({
  attachClosestEdge: (
    data: Parameters<AttachClosestEdge>[0],
    { allowedEdges }: Parameters<AttachClosestEdge>[1],
  ) => ({
    ...data,
    [dnd.closestEdgeKey]: allowedEdges.includes(dnd.closestEdge)
      ? dnd.closestEdge
      : null,
  }),
  extractClosestEdge: (data: Record<string | symbol, unknown>) =>
    (data[dnd.closestEdgeKey] as ClosestEdge | null | undefined) ?? null,
}));

const input: ElementDropTargetGetFeedbackArgs["input"] = {
  altKey: false,
  button: 0,
  buttons: 1,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  clientX: 0,
  clientY: 0,
  pageX: 0,
  pageY: 0,
};

function dragLocation(
  dropTargets: DropTargetRecord[] = [],
): DropPayload["location"] {
  return {
    initial: { input, dropTargets: [] },
    current: { input, dropTargets },
    previous: { dropTargets: [] },
  };
}

function draggableFor(element: HTMLElement) {
  return dnd.draggables.find((candidate) => candidate.element === element);
}

function dropTargetFor(element: Element) {
  return dnd.dropTargets.find((candidate) => candidate.element === element);
}

function requireDropTarget(element: Element) {
  const target = dropTargetFor(element);
  if (!target) {
    throw new Error(`No drop target registered for "${element.textContent}"`);
  }
  return target;
}

function sourceFor(element: HTMLElement): DragSource {
  const registration = draggableFor(element);
  if (!registration) {
    throw new Error(`No draggable registered for "${element.textContent}"`);
  }
  const dragHandle = registration.dragHandle ?? null;
  const source: ElementDragPayload = {
    element: registration.element,
    dragHandle,
    data:
      registration.getInitialData?.({
        input,
        element: registration.element,
        dragHandle,
      }) ?? {},
  };
  return { registration, source };
}

function canDropOn(source: DragSource, target: DropTargetRegistration) {
  return (
    target.canDrop?.({
      input,
      source: source.source,
      element: target.element,
    }) !== false
  );
}

function dropRecordFor(
  source: DragSource,
  target: DropTargetRegistration,
): DropTargetRecord {
  const feedback: ElementDropTargetGetFeedbackArgs = {
    input,
    source: source.source,
    element: target.element,
  };
  if (!canDropOn(source, target)) {
    throw new Error(`Drop rejected by "${target.element.textContent}"`);
  }
  return {
    element: target.element,
    data: target.getData?.(feedback) ?? {},
    dropEffect: target.getDropEffect?.(feedback) ?? "move",
    isActiveDueToStickiness: false,
  };
}

function dispatchDragStart(source: DragSource) {
  const event: ElementEventPayloadMap["onDragStart"] = {
    location: dragLocation(),
    source: source.source,
  };
  act(() => source.registration.onDragStart?.(event));
}

function dispatchTargetEnter(
  source: DragSource,
  target: DropTargetRegistration,
  edge: ClosestEdge,
) {
  dnd.closestEdge = edge;
  const self = dropRecordFor(source, target);
  act(() =>
    target.onDragEnter?.({
      location: dragLocation([self]),
      self,
      source: source.source,
    }),
  );
}

function dispatchTargetLeave(
  source: DragSource,
  target: DropTargetRegistration,
) {
  const self = dropRecordFor(source, target);
  act(() =>
    target.onDragLeave?.({
      location: dragLocation(),
      self,
      source: source.source,
    }),
  );
}

function dispatchDrop(
  source: DragSource,
  target: DropTargetRegistration,
  edge: ClosestEdge,
) {
  dnd.closestEdge = edge;
  const self = dropRecordFor(source, target);
  const base: ElementEventPayloadMap["onDrop"] = {
    location: dragLocation([self]),
    source: source.source,
  };
  act(() => {
    source.registration.onDrop?.(base);
    target.onDrop?.({ ...base, self });
  });
}

interface Book {
  id: string;
  title: string;
  author: string;
  year: number;
}

const BOOKS: Book[] = [
  { id: "r1", title: "Alpha", author: "Ann", year: 2001 },
  { id: "r2", title: "Beta", author: "Bob", year: 2002 },
  { id: "r3", title: "Gamma", author: "Cy", year: 2003 },
];

const COLUMNS: DataColumn<Book>[] = [
  {
    id: "title",
    label: "Title",
    fill: true,
    minWidth: 240,
    pinned: true,
    rowHeader: true,
    sortable: true,
    cell: (book) => (
      <button type="button" data-row-title={book.id}>
        {book.title}
      </button>
    ),
  },
  {
    id: "author",
    label: "Author",
    width: 120,
    sortable: true,
    cell: (book) => book.author,
  },
  {
    id: "year",
    label: "Year",
    width: 80,
    align: "end",
    cell: (book) => String(book.year),
  },
  {
    id: "tags",
    label: "Tags",
    width: 150,
    sortable: true,
    header: () => (
      <>
        Tags
        <button type="button" aria-label="Tags column menu">
          ⋯
        </button>
      </>
    ),
    cell: () => "—",
  },
];

const ORDER = ["title", "author", "year", "tags"];

type HarnessProps = Partial<DataTableProps<Book>> & {
  initialOrder?: string[];
  initialWidths?: Record<string, number>;
  initialSelection?: RowSelectionState;
  withSelection?: boolean;
  onOrder?: (next: string[], moved: string) => void;
  onWidth?: (id: string, width: number | undefined) => void;
  onSelection?: (next: RowSelectionState) => void;
};

function Harness({
  initialOrder = ORDER,
  initialWidths = {},
  initialSelection = {},
  withSelection = false,
  onOrder,
  onWidth,
  onSelection,
  ...props
}: HarnessProps) {
  const [order, setOrder] = useState(initialOrder);
  const [widths, setWidths] = useState(initialWidths);
  const [selected, setSelected] = useState(initialSelection);
  return (
    <DataTable<Book>
      ariaLabel="Books"
      rows={BOOKS}
      columns={COLUMNS}
      getRowId={(book) => book.id}
      density="compact"
      columnOrder={order}
      onColumnOrderChange={(next, moved) => {
        onOrder?.(next, moved);
        setOrder(next);
      }}
      columnWidths={widths}
      onColumnWidthChange={(id, width) => {
        onWidth?.(id, width);
        setWidths((current) => {
          const next = { ...current };
          if (width === undefined) delete next[id];
          else next[id] = width;
          return next;
        });
      }}
      selection={
        withSelection
          ? {
              selected,
              onChange: (next) => {
                onSelection?.(next);
                setSelected(next);
              },
              allLabel: "Select all visible rows",
              rowLabel: (book) => `Select ${book.title}`,
            }
          : undefined
      }
      {...props}
    />
  );
}

const grid = () => screen.getByRole("grid", { name: "Books" });
/** The reorder live region; not role="status", which the host screen owns. */
const announcer = () => {
  const region = grid().parentElement?.querySelector('[aria-live="polite"]');
  if (!(region instanceof HTMLElement)) throw new Error("No live region");
  return region;
};
const headerTexts = () =>
  screen
    .getAllByRole("columnheader")
    .map((th) => th.getAttribute("data-column"));
const col = (id: string) =>
  grid().querySelector<HTMLTableColElement>(`col[data-column="${id}"]`);
const header = (name: string | RegExp) =>
  screen.getByRole("columnheader", { name });

afterEach(() => vi.restoreAllMocks());

describe("DataTable markup", () => {
  it("renders a labelled grid with density, headers, rows and rowheaders", () => {
    render(<Harness />);
    expect(grid()).toHaveAttribute("data-density", "compact");
    expect(grid().tagName).toBe("TABLE");
    expect(
      screen.getAllByRole("columnheader").map((th) => th.textContent),
    ).toEqual(["Title", "Author", "Year", "Tags⋯"]);
    // The resizer names itself; the header name is the label and its content.
    expect(header("Author")).toBeInTheDocument();
    expect(header(/^Tags/)).not.toHaveAccessibleName(/Resize/);
    expect(
      screen.getAllByRole("rowheader").map((td) => td.textContent),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
    const row = screen.getByRole("row", { name: "Alpha" });
    expect(row.tagName).toBe("TR");
    expect(row).toHaveAttribute("data-row-id", "r1");
    expect(within(row).getAllByRole("gridcell")).toHaveLength(3);
  });

  it("puts aria-sort only on sortable columns", () => {
    render(<Harness sort={{ column: "title", direction: "ascending" }} />);
    expect(header(/^Title/)).toHaveAttribute("aria-sort", "ascending");
    expect(header("Author")).toHaveAttribute("aria-sort", "none");
    expect(header("Year")).not.toHaveAttribute("aria-sort");
  });

  it("shows the default sort arrow outside the header name", () => {
    render(<Harness sort={{ column: "author", direction: "descending" }} />);
    expect(header("Author")).toHaveTextContent("Author ↓");
  });

  it("announces through a live region that leaves role=status to its host", () => {
    render(<Harness />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(announcer()).toHaveAttribute("aria-atomic", "true");
  });

  it("renders the empty state when there are no rows", () => {
    render(<Harness rows={[]} emptyState="Nothing here" />);
    expect(screen.getByText("Nothing here").closest("td")).toHaveAttribute(
      "colspan",
      "4",
    );
  });
});

describe("header sort", () => {
  it("sorts on a click on a sortable header", async () => {
    const onHeaderSort = vi.fn();
    render(<Harness onHeaderSort={onHeaderSort} />);
    await userEvent.click(header("Author"));
    expect(onHeaderSort).toHaveBeenCalledWith("author");
    await userEvent.click(header("Year"));
    expect(onHeaderSort).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks from interactive descendants", async () => {
    const onHeaderSort = vi.fn();
    render(<Harness onHeaderSort={onHeaderSort} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Tags column menu" }),
    );
    await userEvent.click(
      screen.getByRole("separator", { name: "Resize the Author column" }),
    );
    expect(onHeaderSort).not.toHaveBeenCalled();
  });
});

describe("column widths", () => {
  it("renders widths through the colgroup; the fill column has none", () => {
    render(<Harness initialWidths={{ author: 200 }} />);
    expect(col("author")?.style.width).toBe("200px");
    expect(col("year")?.style.width).toBe("80px");
    expect(col("title")?.style.width).toBe("");
    expect(grid().style.minWidth).toBe(`${240 + 200 + 80 + 150}px`);
    expect(grid().className).toContain("table-fixed");
  });

  it("names each resizer and gives none to the fill column", () => {
    render(<Harness />);
    expect(
      screen.getAllByRole("separator").map((s) => s.getAttribute("aria-label")),
    ).toEqual([
      "Resize the Author column",
      "Resize the Year column",
      "Resize the Tags column",
    ]);
  });

  it("resizes by keyboard in 16px steps", async () => {
    const onWidth = vi.fn();
    render(<Harness onWidth={onWidth} />);
    const handle = screen.getByRole("separator", {
      name: "Resize the Author column",
    });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onWidth).toHaveBeenCalledWith("author", 136);
    expect(col("author")?.style.width).toBe("136px");
  });

  it("previews a pointer drag and commits once on release", () => {
    const onWidth = vi.fn();
    render(<Harness onWidth={onWidth} />);
    const handle = screen.getByRole("separator", {
      name: "Resize the Author column",
    });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 130 });
    fireEvent.pointerMove(window, { clientX: 140 });
    expect(col("author")?.style.width).toBe("160px");
    expect(onWidth).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith("author", 160);
    expect(col("author")?.style.width).toBe("160px");
  });

  it("clamps to the column bounds", async () => {
    const onWidth = vi.fn();
    render(<Harness onWidth={onWidth} />);
    const handle = screen.getByRole("separator", {
      name: "Resize the Year column",
    });
    handle.focus();
    await userEvent.keyboard("{Home}");
    expect(onWidth).toHaveBeenCalledWith("year", 40);
  });

  it("resets a width on double-click", async () => {
    const onWidth = vi.fn();
    render(<Harness initialWidths={{ author: 200 }} onWidth={onWidth} />);
    await userEvent.dblClick(
      screen.getByRole("separator", { name: "Resize the Author column" }),
    );
    expect(onWidth).toHaveBeenLastCalledWith("author", undefined);
    expect(col("author")?.style.width).toBe("120px");
  });

  it("keeps the grid element and focus through a resize", async () => {
    render(<Harness />);
    const before = grid();
    const handle = screen.getByRole("separator", {
      name: "Resize the Author column",
    });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(grid()).toBe(before);
    expect(handle).toHaveFocus();
  });
});

describe("column visibility and pinning", () => {
  it("hides columns from the header, colgroup and rows", () => {
    render(<Harness columnVisibility={{ year: false }} />);
    expect(headerTexts()).toEqual(["title", "author", "tags"]);
    expect(col("year")).toBeNull();
    const row = screen.getByRole("row", { name: "Alpha" });
    expect(within(row).getAllByRole("gridcell")).toHaveLength(2);
  });

  it("follows the column order but keeps pinned columns first", () => {
    render(<Harness initialOrder={["tags", "author", "title", "year"]} />);
    expect(headerTexts()).toEqual(["title", "tags", "author", "year"]);
    const row = screen.getByRole<HTMLTableRowElement>("row", {
      name: "Alpha",
    });
    expect(
      Array.from(row.cells).map((td) => td.getAttribute("data-column")),
    ).toEqual(["title", "tags", "author", "year"]);
    expect(
      Array.from(grid().querySelectorAll("col")).map((c) =>
        c.getAttribute("data-column"),
      ),
    ).toEqual(["title", "tags", "author", "year"]);
  });

  it("appends columns missing from the order", () => {
    render(<Harness initialOrder={["year"]} />);
    expect(headerTexts()).toEqual(["title", "year", "author", "tags"]);
  });
});

describe("row selection", () => {
  it("renders a pinned checkbox column with labels", () => {
    render(
      <Harness withSelection initialOrder={["tags", "title", "author"]} />,
    );
    expect(headerTexts()[0]).toBe("__select");
    expect(
      screen.getByRole("checkbox", { name: "Select all visible rows" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Alpha" }),
    ).not.toBeChecked();
    expect(screen.getByRole("row", { name: "Alpha" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("toggles a row without activating it", async () => {
    const onSelection = vi.fn();
    const onRowActivate = vi.fn();
    render(
      <Harness
        withSelection
        onSelection={onSelection}
        onRowActivate={onRowActivate}
      />,
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select Beta" }),
    );
    expect(onSelection).toHaveBeenLastCalledWith({ r2: true });
    expect(screen.getByRole("checkbox", { name: "Select Beta" })).toBeChecked();
    expect(screen.getByRole("row", { name: "Beta" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The cell around the checkbox swallows the click too.
    await userEvent.click(
      screen
        .getByRole("checkbox", { name: "Select Beta" })
        .closest("td") as HTMLElement,
    );
    expect(onRowActivate).not.toHaveBeenCalled();
  });

  it("marks the header checkbox indeterminate when some rows are selected", () => {
    render(<Harness withSelection initialSelection={{ r1: true }} />);
    const all = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Select all visible rows",
    });
    expect(all.indeterminate).toBe(true);
    expect(all).not.toBeChecked();
  });

  it("selects exactly the visible rows, then clears the whole selection", async () => {
    const onSelection = vi.fn();
    render(
      <Harness
        withSelection
        initialSelection={{ r1: true, gone: true }}
        onSelection={onSelection}
      />,
    );
    const all = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Select all visible rows",
    });
    await userEvent.click(all);
    expect(onSelection).toHaveBeenLastCalledWith({
      r1: true,
      r2: true,
      r3: true,
    });
    expect(all).toBeChecked();
    expect(all.indeterminate).toBe(false);
    await userEvent.click(all);
    expect(onSelection).toHaveBeenLastCalledWith({});
  });

  it("clears rows selected elsewhere when every visible row is selected", async () => {
    const onSelection = vi.fn();
    render(
      <Harness
        withSelection
        initialSelection={{ r1: true, r2: true, r3: true, gone: true }}
        onSelection={onSelection}
      />,
    );
    const all = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Select all visible rows",
    });
    expect(all).toBeChecked();
    await userEvent.click(all);
    expect(onSelection).toHaveBeenLastCalledWith({});
  });

  it("is not indeterminate when only rows elsewhere are selected", () => {
    render(<Harness withSelection initialSelection={{ gone: true }} />);
    const all = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Select all visible rows",
    });
    expect(all.indeterminate).toBe(false);
    expect(all).not.toBeChecked();
  });

  it("disables the header checkbox without rows", () => {
    render(<Harness withSelection rows={[]} />);
    expect(
      screen.getByRole("checkbox", { name: "Select all visible rows" }),
    ).toBeDisabled();
  });

  it("passes the selected state to rowClassName; rows carry group", () => {
    render(
      <Harness
        withSelection
        initialSelection={{ r2: true }}
        rowClassName={(_book, { selected }) =>
          selected ? "is-selected" : "is-plain"
        }
      />,
    );
    const beta = screen.getByRole("row", { name: "Beta" });
    expect(beta).toHaveClass("group", "is-selected");
    expect(screen.getByRole("row", { name: "Alpha" })).toHaveClass(
      "group",
      "is-plain",
    );
  });
});

describe("row activation", () => {
  it("activates a row on click, but not from its controls", async () => {
    const onRowActivate = vi.fn();
    render(<Harness onRowActivate={onRowActivate} />);
    await userEvent.click(screen.getByText("Bob"));
    expect(onRowActivate).toHaveBeenCalledWith(BOOKS[1]);
    await userEvent.click(screen.getByRole("button", { name: "Gamma" }));
    expect(onRowActivate).toHaveBeenCalledTimes(1);
  });

  it("activates the focused row or cell on Enter", async () => {
    const onRowActivate = vi.fn();
    render(<Harness onRowActivate={onRowActivate} />);
    screen.getByRole("row", { name: "Gamma" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenLastCalledWith(BOOKS[2]);
    screen.getByText("Ann").focus();
    await userEvent.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenLastCalledWith(BOOKS[0]);
  });
});

describe("header drag reorder", () => {
  it("registers movable headers only; pinned headers are neither source nor target", () => {
    render(<Harness />);
    expect(draggableFor(header(/^Title/))).toBeUndefined();
    expect(dropTargetFor(header(/^Title/))).toBeUndefined();
    expect(draggableFor(header("Author"))).toBeDefined();
    expect(dropTargetFor(header("Author"))).toBeDefined();
    // Dragging starts from the label, never from the resizer.
    expect(draggableFor(header("Author"))?.dragHandle).toBe(
      screen.getByText("Author"),
    );
  });

  it("registers nothing without onColumnOrderChange", () => {
    render(
      <DataTable<Book>
        ariaLabel="Books"
        rows={BOOKS}
        columns={COLUMNS}
        getRowId={(book) => book.id}
        density="comfortable"
        columnOrder={ORDER}
        columnWidths={{}}
      />,
    );
    expect(dnd.draggables).toHaveLength(0);
    expect(dnd.dropTargets).toHaveLength(0);
    expect(header("Author")).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("shows an inset indicator on enter, dims the dragged header, and clears on leave", () => {
    render(<Harness />);
    const source = sourceFor(header(/^Tags/));
    const target = requireDropTarget(header("Author"));
    dispatchDragStart(source);
    expect(header(/^Tags/)).toHaveClass("opacity-50");
    dispatchTargetEnter(source, target, "left");
    expect(header("Author").style.boxShadow).toBe(
      "inset 2px 0 0 0 var(--accent)",
    );
    dispatchTargetEnter(source, target, "right");
    expect(header("Author").style.boxShadow).toBe(
      "inset -2px 0 0 0 var(--accent)",
    );
    dispatchTargetLeave(source, target);
    expect(header("Author").style.boxShadow).toBe("");
  });

  it("moves the dropped column and announces it", () => {
    const onOrder = vi.fn();
    render(<Harness onOrder={onOrder} />);
    const source = sourceFor(header(/^Tags/));
    dispatchDragStart(source);
    dispatchDrop(source, requireDropTarget(header("Author")), "left");
    expect(onOrder).toHaveBeenCalledWith(
      ["title", "tags", "author", "year"],
      "tags",
    );
    expect(headerTexts()).toEqual(["title", "tags", "author", "year"]);
    expect(header(/^Tags/)).not.toHaveClass("opacity-50");
    expect(header("Author").style.boxShadow).toBe("");
    expect(announcer()).toHaveTextContent("Moved Tags to position 2 of 4.");
  });

  it("rejects drags from another table", () => {
    render(
      <>
        <Harness />
        <Harness ariaLabel="Other" />
      </>,
    );
    const [, otherAuthor] = screen.getAllByRole("columnheader", {
      name: "Author",
    });
    const source = sourceFor(otherAuthor);
    const target = requireDropTarget(
      screen.getAllByRole("columnheader", { name: "Year" })[0],
    );
    expect(canDropOn(source, target)).toBe(false);
  });
});

describe("keyboard reorder", () => {
  it("advertises Alt+Arrow on movable headers only", () => {
    render(<Harness />);
    expect(header("Author")).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+ArrowLeft Alt+ArrowRight",
    );
    expect(header(/^Title/)).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("moves a focused header with Alt+Arrow, keeps focus and the grid, and announces", async () => {
    const onOrder = vi.fn();
    const onWidth = vi.fn();
    render(<Harness onOrder={onOrder} onWidth={onWidth} />);
    const before = grid();
    const author = header("Author");
    // The resizer is outside navigation, so the header holds focus itself.
    author.focus();
    expect(author).toHaveFocus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onWidth).not.toHaveBeenCalled();
    expect(onOrder).toHaveBeenLastCalledWith(
      ["title", "year", "author", "tags"],
      "author",
    );
    expect(headerTexts()).toEqual(["title", "year", "author", "tags"]);
    expect(grid()).toBe(before);
    expect(author).toHaveFocus();
    expect(announcer()).toHaveTextContent("Moved Author to position 3 of 4.");
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(headerTexts()).toEqual(["title", "year", "tags", "author"]);
    expect(author).toHaveFocus();
  });

  it("walks the header row past resizers", async () => {
    render(<Harness />);
    header("Author").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(header("Year")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("button", { name: "Tags column menu" }),
    ).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(header("Author")).toHaveFocus();
  });

  it("resizes in resize mode: Enter in, arrows resize, Escape out", async () => {
    const onWidth = vi.fn();
    render(<Harness onWidth={onWidth} />);
    const author = header("Author");
    const resizer = screen.getByRole("separator", {
      name: "Resize the Author column",
    });
    expect(resizer).toHaveAttribute("tabindex", "-1");
    author.focus();
    await userEvent.keyboard("{Enter}");
    expect(resizer).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onWidth).toHaveBeenLastCalledWith("author", 104);
    await userEvent.keyboard("{End}");
    expect(onWidth).toHaveBeenLastCalledWith("author", 640);
    expect(resizer).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(author).toHaveFocus();
    await userEvent.keyboard("{Enter}{Enter}");
    expect(author).toHaveFocus();
    expect(onWidth).toHaveBeenCalledTimes(2);
  });

  it("moves the column, not the width, with Alt+Arrow in resize mode", async () => {
    const onOrder = vi.fn();
    const onWidth = vi.fn();
    render(<Harness onOrder={onOrder} onWidth={onWidth} />);
    header("Author").focus();
    await userEvent.keyboard("{Enter}{Alt>}{ArrowRight}{/Alt}");
    expect(onOrder).toHaveBeenLastCalledWith(
      ["title", "year", "author", "tags"],
      "author",
    );
    expect(onWidth).not.toHaveBeenCalled();
    expect(
      screen.getByRole("separator", { name: "Resize the Author column" }),
    ).toHaveFocus();
  });

  it("describes resizable headers without changing their names", () => {
    render(<Harness />);
    expect(header("Author")).toHaveAccessibleDescription(
      "Press Enter to resize",
    );
    expect(header(/^Title$/)).not.toHaveAttribute("aria-describedby");
  });

  it("moves from a header's control and keeps focus on that control", async () => {
    const onOrder = vi.fn();
    render(<Harness onOrder={onOrder} />);
    const menu = screen.getByRole("button", { name: "Tags column menu" });
    menu.focus();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(headerTexts()).toEqual(["title", "author", "tags", "year"]);
    expect(menu).toHaveFocus();
  });

  it("never moves past a pinned column or a pinned header", async () => {
    const onOrder = vi.fn();
    render(<Harness onOrder={onOrder} />);
    header("Author").focus();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    screen.getByRole("button", { name: "Alpha" }).focus();
    header(/^Title/).focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onOrder).not.toHaveBeenCalled();
    expect(headerTexts()).toEqual(ORDER);
  });

  it("counts only visible columns when moving and announcing", async () => {
    render(<Harness columnVisibility={{ year: false }} />);
    header("Author").focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(headerTexts()).toEqual(["title", "tags", "author"]);
    expect(announcer()).toHaveTextContent("Moved Author to position 3 of 3.");
  });
});

describe("virtualised rows", () => {
  const MANY: Book[] = Array.from({ length: 100 }, (_, i) => ({
    id: `v${i + 1}`,
    title: `Book ${i + 1}`,
    author: `Author ${i + 1}`,
    year: 1900 + i,
  }));
  // 40px rows in a 400px box under a 34px (compact) header.
  const VIRTUAL = { rowHeight: 40, maxHeight: 400, overscan: 2 };

  /** jsdom has no layout: every element gets the box's height and the full
   *  table's scroll height. */
  function mockLayout() {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
      VIRTUAL.maxHeight,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
      VIRTUAL.maxHeight,
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      34 + MANY.length * VIRTUAL.rowHeight,
    );
  }

  /** The scroll box, with a scrollTop that scrollTo and assignment move. */
  function scrollBox() {
    const box = grid().parentElement;
    if (!(box instanceof HTMLDivElement)) throw new Error("No scroll box");
    let top = 0;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    box.scrollTo = ((options: ScrollToOptions) => {
      top = options.top ?? top;
    }) as typeof box.scrollTo;
    return {
      box,
      scroll(to: number) {
        top = to;
        fireEvent.scroll(box);
      },
    };
  }

  const table = () =>
    screen.getByRole<HTMLTableElement>("grid", { name: "Books" });
  const bodyRows = () =>
    Array.from(table().tBodies[0].rows).filter(
      (row) => !row.hasAttribute("data-grid-spacer"),
    );
  const rowIds = () => bodyRows().map((row) => row.dataset.rowId);

  it("renders only the rows in view plus overscan, with ARIA row positions", () => {
    mockLayout();
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    // Rows 1–10 meet the 400px box; two more of overscan.
    expect(rowIds()).toEqual(MANY.slice(0, 12).map((book) => book.id));
    expect(grid()).toHaveAttribute("aria-rowcount", "101");
    expect(table().tHead?.rows[0]).toHaveAttribute("aria-rowindex", "1");
    expect(bodyRows()[0]).toHaveAttribute("aria-rowindex", "2");
    expect(bodyRows()[11]).toHaveAttribute("aria-rowindex", "13");
    expect(bodyRows()[0].style.height).toBe("40px");
  });

  it("keeps the full height with hidden spacer rows that are not grid rows", () => {
    mockLayout();
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    const spacers = grid().querySelectorAll<HTMLTableRowElement>(
      "tr[data-grid-spacer]",
    );
    // No rows above the window yet: only the bottom spacer, 88 rows tall.
    expect(spacers).toHaveLength(1);
    expect(spacers[0]).toHaveAttribute("aria-hidden", "true");
    expect(spacers[0].style.height).toBe(`${88 * 40}px`);
    expect(spacers[0].tabIndex).toBe(-1);
    // One header row and twelve body rows are exposed.
    expect(screen.getAllByRole("row")).toHaveLength(13);
  });

  it("scrolls in its own box under a sticky header", () => {
    mockLayout();
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    const { box } = scrollBox();
    expect(box.style.maxHeight).toBe("400px");
    expect(box.className).toContain("overflow-auto");
    expect(table().tHead?.className).toContain("sticky");
  });

  it("moves the window on scroll", () => {
    mockLayout();
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    const { scroll } = scrollBox();
    act(() => scroll(2000));
    const ids = rowIds();
    // 2000px down (less the header) is row 50 (0-based 49).
    expect(ids[0]).toBe("v48");
    expect(ids).toContain("v50");
    expect(ids).not.toContain("v1");
    const top = grid().querySelector<HTMLTableRowElement>(
      "tr[data-grid-spacer]",
    );
    expect(top?.style.height).toBe(`${47 * 40}px`);
  });

  it("reaches the last row with End and the first with Ctrl+Home", async () => {
    mockLayout();
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    scrollBox();
    screen.getByRole("row", { name: "Book 1" }).focus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("row", { name: "Book 100" })).toHaveFocus();
    expect(rowIds()).not.toContain("v1");
    screen.getByText("Author 100").focus();
    await userEvent.keyboard("{Control>}{Home}{/Control}");
    expect(screen.getByRole("button", { name: "Book 1" })).toHaveFocus();
  });

  it("steps with the arrow keys past the rendered window", async () => {
    mockLayout();
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    scrollBox();
    screen.getByRole("row", { name: "Book 12" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("row", { name: "Book 13" })).toHaveFocus();
    await userEvent.keyboard("{End}{ArrowUp}");
    expect(screen.getByRole("row", { name: "Book 99" })).toHaveFocus();
  });

  it("renders the capped window while the box has no layout", () => {
    // No layout mock: jsdom (or a display:none ancestor) reports 0px.
    render(<Harness rows={MANY} virtualize={VIRTUAL} />);
    expect(rowIds()).toEqual(MANY.slice(0, 12).map((book) => book.id));
  });

  it("leaves the plain table without row positions or a scroll box", () => {
    render(<Harness />);
    expect(grid()).not.toHaveAttribute("aria-rowcount");
    expect(grid().parentElement).not.toHaveClass("overflow-auto");
    expect(grid().querySelector("[aria-rowindex]")).toBeNull();
  });
});
