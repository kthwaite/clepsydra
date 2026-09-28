import type {
  draggable as draggableAdapter,
  dropTargetForElements as dropTargetForElementsAdapter,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params: { slug: string };
    [key: string]: unknown;
  }) => (
    <a {...props} href={to.replace("$slug", params.slug)}>
      {children}
    </a>
  ),
}));

// The DnD adapter is mocked so a test can drive a header drop directly.
type DraggableRegistration = Parameters<typeof draggableAdapter>[0];
type DropTargetRegistration = Parameters<
  typeof dropTargetForElementsAdapter
>[0];

const dnd = vi.hoisted(() => ({
  draggables: [] as DraggableRegistration[],
  dropTargets: [] as DropTargetRegistration[],
  edge: "left" as "left" | "right",
  edgeKey: Symbol("closest-edge"),
}));

function register<T>(list: T[], item: T) {
  list.push(item);
  return () => {
    const at = list.indexOf(item);
    if (at !== -1) list.splice(at, 1);
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
    data: Record<string | symbol, unknown>,
    { allowedEdges }: { allowedEdges: string[] },
  ) => ({
    ...data,
    [dnd.edgeKey]: allowedEdges.includes(dnd.edge) ? dnd.edge : null,
  }),
  extractClosestEdge: (data: Record<string | symbol, unknown>) =>
    (data[dnd.edgeKey] as string | null | undefined) ?? null,
}));

import type {
  BaseDetailResponse,
  BaseMemberCapability,
  QueryOutput,
} from "#/api/bases";
import { BaseTableView } from "#/components/bases/BaseTableView";
import { columnWidthsKey } from "#/components/bases/column-widths";
import { EMPTY_OVERRIDES } from "#/components/bases/view-overrides";

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "revision-1",
  name: "Reading Log",
  properties: [
    { key: "author", definition: { type: "text" } },
    { key: "rating", definition: { type: "number" } },
    {
      key: "status",
      definition: { type: "select", options: ["queued", "reading"] },
    },
    { key: "done", definition: { type: "bool" } },
  ],
  views: [
    {
      name: "Continues",
      layout: "table",
      columns: ["title", "author", "status", "body", "done"],
    },
    { name: "Shelf", layout: "table", columns: ["title", "author"] },
  ],
  diagnostics: [],
  member_creation: [],
};

const row = {
  id: "01",
  path: "book.md",
  title: "The Book of the New Sun",
  kind: "BOOK",
  columns: {
    author: "Gene Wolfe",
    rating: 4.5,
    status: "reading",
    body: "Severian",
    done: true,
  },
};

const flat: QueryOutput = {
  shape: "flat",
  rows: [row],
  total: 1,
  aggregates: [],
};

const capability: BaseMemberCapability = {
  view: "Continues",
  enabled: true,
  fields: [],
  blockers: [],
};

type ViewProps = Parameters<typeof BaseTableView>[0];

function renderView(overrides: Partial<ViewProps> = {}) {
  const spies = {
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
    onReorderColumns: vi.fn(),
    onHideColumn: vi.fn(),
    onShowColumn: vi.fn(),
    onOpenPageInNewTab: vi.fn(),
  };
  const element = (next: Partial<ViewProps> = {}) => (
    <BaseTableView
      definition={definition}
      activeView="Continues"
      output={flat}
      sort={undefined}
      memberCapability={capability}
      overrides={EMPTY_OVERRIDES}
      {...spies}
      {...overrides}
      {...next}
    />
  );
  const result = render(element());
  return {
    ...spies,
    rerender: (next: Partial<ViewProps>) => result.rerender(element(next)),
  };
}

const headerIds = () =>
  screen
    .getAllByRole("columnheader")
    .map((header) => header.getAttribute("data-column"));

function colWidth(column: string): string {
  const col = screen
    .getByRole("grid")
    .querySelector<HTMLElement>(`col[data-column="${column}"]`);
  return col?.style.width ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  dnd.draggables.length = 0;
  dnd.dropTargets.length = 0;
});

describe("Base column widths", () => {
  it("gives the title the leftover width and every other column a default", () => {
    renderView();
    expect(colWidth("title")).toBe("");
    expect(colWidth("author")).toBe("160px");
    expect(colWidth("body")).toBe("280px");
    expect(
      screen.queryByRole("separator", { name: "Resize the title column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize the author column" }),
    ).toBeInTheDocument();
  });

  it("persists a resize per base and view", () => {
    const view = renderView();
    const separator = screen.getByRole("separator", {
      name: "Resize the author column",
    });
    act(() => separator.focus());
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(colWidth("author")).toBe("176px");
    expect(
      JSON.parse(
        window.localStorage.getItem(columnWidthsKey("reading", "Continues")) ??
          "{}",
      ),
    ).toEqual({ author: 176 });

    view.rerender({ activeView: "Shelf" });
    expect(colWidth("author")).toBe("160px");
    view.rerender({ activeView: "Continues" });
    expect(colWidth("author")).toBe("176px");
  });

  it("resets a width on double-click", () => {
    window.localStorage.setItem(
      columnWidthsKey("reading", "Continues"),
      JSON.stringify({ author: 300 }),
    );
    renderView();
    expect(colWidth("author")).toBe("300px");
    fireEvent.doubleClick(
      screen.getByRole("separator", { name: "Resize the author column" }),
    );
    expect(colWidth("author")).toBe("160px");
  });

  it("reaches a column's resizer from its header menu", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(
      screen.getByRole("button", { name: "author column menu" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Resize column" }),
    );
    const separator = screen.getByRole("separator", {
      name: "Resize the author column",
    });
    await vi.waitFor(() => expect(separator).toHaveFocus());
    await user.keyboard("{ArrowLeft}");
    expect(colWidth("author")).toBe("144px");
    // Escape leaves resize mode for the header.
    await user.keyboard("{Escape}");
    expect(separator).not.toHaveFocus();
    expect(separator.closest("th")).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("offers no resize for the title column", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "title column menu" }));
    const item = await screen.findByRole("menuitem", { name: /Resize column/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Base column reorder", () => {
  it("moves a header with Alt+Arrow and keeps hidden columns in their slots", async () => {
    const user = userEvent.setup();
    const view = renderView({
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["status"] },
    });
    expect(headerIds()).toEqual(["title", "author", "body", "done"]);
    const menu = screen.getByRole("button", { name: "author column menu" });
    act(() => menu.focus());
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(view.onReorderColumns).toHaveBeenLastCalledWith([
      "title",
      "status",
      "body",
      "author",
      "done",
    ]);
  });

  it("writes the order through the override and keeps the grid and focus", async () => {
    const user = userEvent.setup();
    const view = renderView();
    const grid = screen.getByRole("grid");
    const menu = screen.getByRole("button", { name: "author column menu" });
    act(() => menu.focus());
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    const order = view.onReorderColumns.mock.lastCall?.[0] as string[];
    expect(order).toEqual(["title", "status", "author", "body", "done"]);
    view.rerender({
      overrides: { ...EMPTY_OVERRIDES, columnOrder: order },
    });
    expect(screen.getByRole("grid")).toBe(grid);
    expect(headerIds()).toEqual(["title", "status", "author", "body", "done"]);
    expect(
      screen.getByRole("button", { name: "author column menu" }),
    ).toHaveFocus();
  });

  it("moves a header by drag", () => {
    const view = renderView();
    const th = (column: string) =>
      screen
        .getAllByRole("columnheader")
        .find((header) => header.getAttribute("data-column") === column);
    const source = dnd.draggables.find((d) => d.element === th("done"));
    const target = dnd.dropTargets.find((d) => d.element === th("author"));
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    if (!source || !target) return;
    const input = {
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
    const payload = {
      element: source.element,
      dragHandle: source.dragHandle ?? null,
      data:
        source.getInitialData?.({
          input,
          element: source.element,
          dragHandle: source.dragHandle ?? null,
        }) ?? {},
    };
    dnd.edge = "left";
    const self = {
      element: target.element,
      data:
        target.getData?.({ input, source: payload, element: target.element }) ??
        {},
      dropEffect: "move" as const,
      isActiveDueToStickiness: false,
    };
    const location = {
      initial: { input, dropTargets: [] },
      current: { input, dropTargets: [self] },
      previous: { dropTargets: [] },
    };
    act(() => target.onDrop?.({ location, source: payload, self }));
    expect(view.onReorderColumns).toHaveBeenLastCalledWith([
      "title",
      "done",
      "author",
      "status",
      "body",
    ]);
  });

  it("never moves the title column", () => {
    renderView();
    const title = screen
      .getAllByRole("columnheader")
      .find((header) => header.getAttribute("data-column") === "title");
    expect(title).not.toHaveAttribute("aria-keyshortcuts");
    expect(dnd.draggables.some((d) => d.element === title)).toBe(false);
  });
});

describe("Base rows", () => {
  it("reveals the row ⋯ on hover and tints the hovered row", () => {
    renderView();
    const button = screen.getByRole("button", {
      name: "Row actions for The Book of the New Sun",
    });
    const tr = button.closest("tr");
    expect(tr).toHaveClass("group");
    expect(tr?.className).toContain("hover:*:bg-sink");
    expect(button.className).toContain("group-hover:opacity-100");
    expect(button.className).toContain("group-hover:pointer-events-auto");
    expect(button.className).not.toContain("group-data-[hovered]");
  });
});

describe("Base editors keep their keys", () => {
  it("moves the caret, not focus, with arrows inside a text editor", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const input = screen.getByRole("textbox", { name: "Edit text" });
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowLeft}{Home}{End}{ArrowRight}{ArrowUp}");
    expect(input).toHaveFocus();
    await user.keyboard("!{Enter}");
    expect(view.onCommitCell).toHaveBeenCalledWith(
      expect.objectContaining({ id: "01" }),
      "author",
      "Gene Wolfe!",
      undefined,
    );
  });

  it.each([
    ["status", "reading"],
    ["done", "true"],
  ])("keeps grid keys away from the open %s editor", async (_column, value) => {
    const user = userEvent.setup();
    renderView();
    const cell = screen.getByRole("button", { name: value });
    await user.click(cell);
    const editor = document.activeElement as HTMLElement;
    expect(editor.closest("[data-grid-editor]")).not.toBeNull();
    await user.keyboard("{End}{Home}");
    expect(editor).toHaveFocus();
  });
});

describe("Base read-only and compact grids", () => {
  it("offers no sort, resize or reorder when read-only", () => {
    const view = renderView({ readOnly: true });
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header).not.toHaveAttribute("aria-sort");
      expect(header).not.toHaveAttribute("aria-keyshortcuts");
    }
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
    expect(dnd.draggables).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("grid")).getByText("author"));
    expect(view.onSortChange).not.toHaveBeenCalled();
  });

  it("keeps the compact header sticky inside the scroller", () => {
    renderView({ chrome: "compact" });
    const scroller = screen.getByTestId("base-table-scroller");
    const thead = scroller.querySelector("thead");
    expect(thead).not.toBeNull();
    expect(thead).toHaveClass("sticky", "top-0");
  });
});
