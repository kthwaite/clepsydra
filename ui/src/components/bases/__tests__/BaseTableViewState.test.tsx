import { render, screen, waitFor, within } from "@testing-library/react";
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

import type { BaseDetailResponse, QueryOutput } from "#/api/bases";
import {
  BaseTableView,
  type BaseTableViewProps,
} from "#/components/bases/BaseTableView";
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
  ],
  views: [
    {
      name: "Shelf",
      layout: "table",
      group_by: "status",
      columns: ["title", "author", "rating"],
      labels: { author: "Writer" },
    },
    { name: "Bare", layout: "table", columns: ["author", "rating"] },
  ],
  diagnostics: [],
  member_creation: [],
};

const readingRow = {
  id: "row-reading",
  path: "always-coming-home.md",
  title: "Always Coming Home",
  kind: "BOOK",
  columns: { author: "Le Guin", rating: 8 },
};
const queuedRow = {
  id: "row-queued",
  path: "the-dispossessed.md",
  title: "The Dispossessed",
  kind: "BOOK",
  columns: { author: "Le Guin", rating: 9 },
};

const grouped: QueryOutput = {
  shape: "grouped",
  groups: [
    { key: "reading", total: 1, aggregates: [], rows: [readingRow] },
    { key: "queued", total: 1, aggregates: [], rows: [queuedRow] },
  ],
};

const GROUPS_KEY = "clepsydra.bases.groups.reading.shelf.status";

function renderView(overrides: Partial<BaseTableViewProps> = {}) {
  const props: BaseTableViewProps = {
    definition,
    activeView: "Shelf",
    onViewChange: vi.fn(),
    output: grouped,
    sort: undefined,
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
    ...overrides,
  };
  return render(<BaseTableView {...props} />);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("group collapse", () => {
  it("folds one group, keeping its count, and remembers the fold", async () => {
    const user = userEvent.setup();
    const { unmount } = renderView();
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    const trigger = screen.getByRole("button", { name: "reading" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId as string)).toContainElement(
      screen.getByRole("grid", { name: "Reading Log — reading" }),
    );

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("grid")).toHaveLength(1);
    expect(
      screen.queryByRole("grid", { name: "Reading Log — reading" }),
    ).not.toBeInTheDocument();
    expect(trigger.parentElement).toHaveTextContent("1 row");
    expect(window.localStorage.getItem(GROUPS_KEY)).toBe('["\\"reading\\""]');

    unmount();
    renderView();
    expect(screen.getByRole("button", { name: "reading" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getAllByRole("grid")).toHaveLength(1);
  });

  it("collapses and expands everything from one toolbar toggle", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryAllByRole("grid")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Collapse all" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    expect(window.localStorage.getItem(GROUPS_KEY)).toBe("[]");
  });

  it("offers no toggle for a flat view", () => {
    renderView({
      activeView: "Bare",
      output: { shape: "flat", total: 1, rows: [readingRow], aggregates: [] },
    });
    expect(
      screen.queryByRole("button", { name: /Collapse all|Expand all/ }),
    ).not.toBeInTheDocument();
  });

  it("scopes the fold to the grouping field", () => {
    window.localStorage.setItem(GROUPS_KEY, '["\\"reading\\""]');
    window.localStorage.setItem(
      "clepsydra.bases.groups.reading.shelf.kind",
      '["\\"reading\\""]',
    );
    renderView({
      overrides: { ...EMPTY_OVERRIDES, group: { kind: "by", field: "kind" } },
      output: {
        shape: "grouped",
        groups: [
          { key: "reading", total: 1, aggregates: [], rows: [readingRow] },
        ],
      },
    });
    expect(screen.getByRole("button", { name: "reading" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opens a folded group that holds the row about to take focus", async () => {
    window.localStorage.setItem(GROUPS_KEY, '["\\"queued\\""]');
    renderView({ focusCreatedId: "row-queued", onCreatedRowFocused: vi.fn() });
    const queued = screen.getByRole("button", { name: "queued" });
    expect(queued).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("grid", { name: "Reading Log — queued" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(GROUPS_KEY)).toBe("[]"),
    );
  });

  it("stops the compact viewport autofill while a group is folded", async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn();
    renderView({
      chrome: "compact",
      rowWindow: {
        total: 40,
        loaded: 2,
        hasMore: true,
        isLoadingMore: false,
        cappedBy: undefined,
        loadMore,
      },
    });
    // jsdom measures nothing; report a viewport taller than the folded
    // headers so the short-content effect would fire on the next render.
    const scroller = screen.getByTestId("base-table-scroller");
    Object.defineProperty(scroller, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      value: 60,
      configurable: true,
    });
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryAllByRole("grid")).toHaveLength(0);
    expect(loadMore).not.toHaveBeenCalled();
  });
});

describe("Fields popover", () => {
  it("hides and shows columns through the override callbacks", async () => {
    const user = userEvent.setup();
    const onHideColumn = vi.fn();
    const onShowColumn = vi.fn();
    const onShowHiddenColumns = vi.fn();
    renderView({ onHideColumn, onShowColumn, onShowHiddenColumns });

    await user.click(screen.getByRole("button", { name: "Fields" }));
    const dialog = screen.getByRole("dialog", { name: "Fields" });
    const title = within(dialog).getByRole("checkbox", { name: "title" });
    expect(title).toBeChecked();
    expect(title).toBeDisabled();
    expect(dialog).toHaveTextContent("The title column stays visible");
    expect(
      within(dialog).getByRole("button", { name: "Show all" }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox", { name: "Writer" }));
    expect(onHideColumn).toHaveBeenCalledWith("author");
    expect(onShowColumn).not.toHaveBeenCalled();
  });

  it("counts hidden columns, re-shows one, and shows all", async () => {
    const user = userEvent.setup();
    const onHideColumn = vi.fn();
    const onShowColumn = vi.fn();
    const onShowHiddenColumns = vi.fn();
    renderView({
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["author"] },
      onHideColumn,
      onShowColumn,
      onShowHiddenColumns,
    });

    await user.click(screen.getByRole("button", { name: "Fields (1 hidden)" }));
    const dialog = screen.getByRole("dialog", { name: "Fields" });
    const writer = within(dialog).getByRole("checkbox", { name: "Writer" });
    expect(writer).not.toBeChecked();
    await user.click(writer);
    expect(onShowColumn).toHaveBeenCalledWith("author");
    await user.click(within(dialog).getByRole("button", { name: "Show all" }));
    expect(onShowHiddenColumns).toHaveBeenCalledTimes(1);
  });

  it("keeps the last visible column when the view has no title column", async () => {
    const user = userEvent.setup();
    renderView({
      activeView: "Bare",
      output: { shape: "flat", total: 1, rows: [readingRow], aggregates: [] },
      overrides: { ...EMPTY_OVERRIDES, hiddenColumns: ["rating"] },
      onHideColumn: vi.fn(),
      onShowColumn: vi.fn(),
      onShowHiddenColumns: vi.fn(),
    });
    await user.click(screen.getByRole("button", { name: "Fields (1 hidden)" }));
    const dialog = screen.getByRole("dialog", { name: "Fields" });
    expect(
      within(dialog).getByRole("checkbox", { name: "author" }),
    ).toBeDisabled();
    expect(dialog).toHaveTextContent("The last column stays visible");
    expect(
      within(dialog).getByRole("checkbox", { name: "rating" }),
    ).toBeEnabled();
  });

  it("is absent when read-only or when a callback is missing", () => {
    const { unmount } = renderView({
      readOnly: true,
      onHideColumn: vi.fn(),
      onShowColumn: vi.fn(),
    });
    expect(
      screen.queryByRole("button", { name: /^Fields/ }),
    ).not.toBeInTheDocument();
    unmount();
    renderView({ onHideColumn: vi.fn() });
    expect(
      screen.queryByRole("button", { name: /^Fields/ }),
    ).not.toBeInTheDocument();
  });
});
