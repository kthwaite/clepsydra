import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
