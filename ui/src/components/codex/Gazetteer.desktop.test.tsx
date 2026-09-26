import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FooterControlsHost } from "#/components/codex/FooterControls";
import { Gazetteer, type GazetteerFilters } from "./Gazetteer";

const { content, useContentIndexMock, heightState } = vi.hoisted(() => ({
  content: {
    data: { items: [] as Array<Record<string, unknown>>, total: 0 } as
      | { items: Array<Record<string, unknown>>; total: number }
      | undefined,
    error: null as Error | null,
    isSuccess: true,
  },
  useContentIndexMock: vi.fn(),
  heightState: { value: 0 as number | null },
}));

vi.mock("#/api/index", () => ({
  useContentIndex: (...args: unknown[]) => {
    useContentIndexMock(...args);
    return content;
  },
  useTags: () => ({
    data: [{ tag: "research", count: 1, computed_count: 0 }],
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignBulk: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => false }));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["atlas"],
  useProjectValues: () => ["atlas"],
}));
vi.mock("#/hooks/useElementHeight", () => ({
  useElementHeight: () => [() => {}, heightState.value],
}));

function entry(i: number) {
  return {
    path: `notes/page-${i + 1}.md`,
    title: `Page ${i + 1}`,
    description: null,
    tags: [],
    kind: "NOTE",
    updated_at: "2026-09-01T00:00:00Z",
    word_count: 1200,
  };
}

function makeFilters(over: Partial<GazetteerFilters> = {}): GazetteerFilters {
  return {
    filterState: { text: "", facets: {} },
    sort: "ts",
    page: 1,
    onFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    onPageChange: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  heightState.value = 0;
  content.data = {
    items: Array.from({ length: 20 }, (_, i) => entry(i)),
    total: 45,
  };
  content.isSuccess = true;
  useContentIndexMock.mockClear();
});

describe("Gazetteer header (desktop)", () => {
  it("titles the screen in serif under an Index eyebrow, with the page count", () => {
    render(<Gazetteer filters={makeFilters()} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Gazetteer" }),
    ).toBeVisible();
    expect(screen.getByText("Index")).toBeVisible();
    expect(screen.getByText("45 pages")).toBeVisible();
  });

  it("starts compact and remembers the Compact switch", async () => {
    const user = userEvent.setup();
    const view = render(<Gazetteer filters={makeFilters()} />);
    const sw = screen.getByRole("switch", { name: "Compact" });
    expect(sw).toBeChecked();
    await user.click(sw);
    expect(sw).not.toBeChecked();
    view.unmount();
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("switch", { name: "Compact" })).not.toBeChecked();
  });

  it("starts comfortable under the spacious preset", () => {
    localStorage.setItem("clepsydra.density", "spacious");
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("switch", { name: "Compact" })).not.toBeChecked();
  });

  it("sorts through the segmented Sort control", async () => {
    const onSortChange = vi.fn();
    render(<Gazetteer filters={makeFilters({ onSortChange })} />);
    const sort = screen.getByRole("radiogroup", { name: "Sort" });
    expect(screen.getByRole("radio", { name: "Edited" })).toBeChecked();
    expect(sort).toBeVisible();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Title" }));
    expect(onSortChange).toHaveBeenCalledWith("title");
  });

  it("offers selection actions in the filter row", async () => {
    const user = userEvent.setup();
    render(<Gazetteer filters={makeFilters()} />);
    const box = screen.getByRole("checkbox", { name: "Select Page 1" });
    await user.click(box);
    expect(screen.getByText("1 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(box).not.toBeChecked();
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("carries no Vessel copy", () => {
    render(<Gazetteer filters={makeFilters()} />);
    const text = document.body.textContent ?? "";
    for (const gone of [
      "/ Index",
      "File-ID",
      "entries",
      "KIND",
      "PROJECT",
      "TAG",
    ]) {
      expect(text).not.toContain(gone);
    }
    expect(screen.getByTestId("filter-bar-input")).toHaveAttribute(
      "placeholder",
      "Filter pages",
    );
  });
});

const COMPACT_10 = 48 + 32 * 10; // 368px: ten compact rows, seven comfortable

describe("Gazetteer table (desktop)", () => {
  it("marks the table's density and switches it", async () => {
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("table")).toHaveAttribute(
      "data-density",
      "compact",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("switch", { name: "Compact" }));
    expect(screen.getByRole("table")).toHaveAttribute(
      "data-density",
      "comfortable",
    );
  });

  it("fits the page size to the table's height", () => {
    heightState.value = COMPACT_10;
    render(<Gazetteer filters={makeFilters({ page: 3 })} />);
    expect(useContentIndexMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
      { enabled: true },
    );
  });

  it("waits for the first measurement before fetching, and keeps a deep-linked page", () => {
    heightState.value = null;
    const onPageChange = vi.fn();
    const filters = makeFilters({ page: 4, onPageChange });
    const view = render(<Gazetteer filters={filters} />);
    expect(useContentIndexMock).toHaveBeenLastCalledWith(expect.anything(), {
      enabled: false,
    });
    heightState.value = COMPACT_10;
    view.rerender(<Gazetteer filters={filters} />);
    expect(useContentIndexMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 10, offset: 30 }),
      { enabled: true },
    );
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("keeps the first visible row when the page size changes, replacing history", async () => {
    heightState.value = COMPACT_10;
    const onPageChange = vi.fn();
    render(<Gazetteer filters={makeFilters({ page: 4, onPageChange })} />);
    await userEvent
      .setup()
      .click(screen.getByRole("switch", { name: "Compact" }));
    expect(onPageChange).toHaveBeenCalledWith(5, true);
  });

  it("numbers rows from the page's first row", () => {
    heightState.value = COMPACT_10;
    content.data = {
      items: Array.from({ length: 10 }, (_, i) => entry(i)),
      total: 45,
    };
    render(<Gazetteer filters={makeFilters({ page: 2 })} />);
    const first = screen.getAllByRole("row")[1];
    expect(within(first).getByText("011")).toBeVisible();
  });

  it("marks the sorted column", () => {
    render(<Gazetteer filters={makeFilters({ sort: "title" })} />);
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(
      screen.getByRole("columnheader", { name: "Edited" }),
    ).not.toHaveAttribute("aria-sort");
  });

  it("puts the row range and page links in the shell footer", async () => {
    heightState.value = COMPACT_10;
    content.data = {
      items: Array.from({ length: 10 }, (_, i) => entry(i)),
      total: 45,
    };
    const onPageChange = vi.fn();
    render(
      <>
        <Gazetteer filters={makeFilters({ onPageChange })} />
        <FooterControlsHost />
      </>,
    );
    expect(screen.getByText("1–10 of 45")).toBeVisible();
    const nav = screen.getByRole("navigation", {
      name: "Gazetteer pagination",
    });
    expect(within(nav).getByRole("button", { name: "Page 1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "Page 5" })).toBeVisible();
    expect(
      within(nav).getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await userEvent
      .setup()
      .click(within(nav).getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("keeps no pager in the page body", () => {
    render(<Gazetteer filters={makeFilters()} />);
    expect(
      screen.queryByRole("navigation", { name: "Gazetteer pagination" }),
    ).toBeNull();
  });

  it("says plainly when nothing matches", () => {
    content.data = { items: [], total: 0 };
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByText("No pages match.")).toBeVisible();
  });
});

describe("Gazetteer errors (desktop)", () => {
  it("keeps the header and filters up when the index query fails", () => {
    content.error = new Error("Unknown Kind: RECIPE");
    content.data = undefined;
    content.isSuccess = false;
    try {
      render(<Gazetteer filters={makeFilters()} />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unknown Kind: RECIPE",
      );
      expect(
        screen.getByRole("heading", { level: 1, name: "Gazetteer" }),
      ).toBeVisible();
      expect(screen.getByTestId("filter-bar-input")).toBeVisible();
    } finally {
      content.error = null;
    }
  });
});
