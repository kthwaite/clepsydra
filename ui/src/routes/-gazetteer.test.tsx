import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentEntry } from "#/api/types";

const routeMocks = vi.hoisted(() => ({
  search: {
    q: "atlas",
    tags: ["research"],
    kind: "PROJECT",
    project: "clepsydra",
    sort: "title",
    page: 2,
  },
  navigate: vi.fn(),
  openTab: vi.fn(),
  useContentIndex: vi.fn(
    (
      ..._args: unknown[]
    ): {
      data?: { items: ContentEntry[]; total: number };
      error?: Error;
      isError?: boolean;
      isSuccess?: boolean;
    } => ({
      data: { items: [], total: 0 },
      isSuccess: true,
    }),
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
}));
vi.mock("#/api/index", () => ({
  useContentIndex: (...args: unknown[]) => routeMocks.useContentIndex(...args),
  useTags: () => ({ data: [{ tag: "research", count: 1 }] }),
}));
vi.mock("#/api/pages", () => ({
  useAssignBulk: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => false }));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => routeMocks.openTab,
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["atlas", "clepsydra"],
  useProjectValues: () => ["atlas", "clepsydra"],
}));

import { appendUniqueTag } from "#/components/codex/gazetteer-filter";
import { Route } from "#/routes/gazetteer";

const GazetteerPage = Route.options.component as () => ReactNode;
const completeSearch = {
  q: "atlas",
  tags: ["research"],
  kind: "PROJECT",
  project: "clepsydra",
  sort: "title",
  page: 2,
};

function resolvedSearch() {
  const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
    search:
      | typeof completeSearch
      | ((current: typeof completeSearch) => typeof completeSearch);
  };
  return typeof navigation.search === "function"
    ? navigation.search(completeSearch)
    : navigation.search;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(routeMocks.search, completeSearch);
});

describe("appendUniqueTag", () => {
  it("preserves input order and returns the selected array when the exact tag is already present", () => {
    const selectedTags = ["pkm"];

    expect(appendUniqueTag(selectedTags, "research")).toEqual([
      "pkm",
      "research",
    ]);
    expect(appendUniqueTag(selectedTags, "pkm")).toBe(selectedTags);
  });
});

describe("Gazetteer route filters", () => {
  it("validates the complete bookmarkable query", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch(completeSearch as any)).toEqual(completeSearch);
  });

  it("preserves an explicit unknown Kind and surfaces the rejected query", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({ ...completeSearch, kind: "RECIPE" } as any),
    ).toEqual({
      ...completeSearch,
      kind: "RECIPE",
    });

    routeMocks.search.kind = "RECIPE";
    routeMocks.useContentIndex.mockReturnValueOnce({
      error: new Error("Unknown Kind: RECIPE"),
      isError: true,
      isSuccess: false,
    });
    render(<GazetteerPage />);

    expect(routeMocks.useContentIndex).toHaveBeenLastCalledWith({
      q: "atlas",
      tags: ["research"],
      kind: "RECIPE",
      project: "clepsydra",
      limit: 20,
      offset: 20,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown Kind: RECIPE");
  });

  it("keeps quotation available as a backend-facing kind filter", () => {
    routeMocks.search.kind = "QUOTE";
    render(<GazetteerPage />);
    expect(routeMocks.useContentIndex).toHaveBeenLastCalledWith({
      q: "atlas",
      tags: ["research"],
      kind: "QUOTE",
      project: "clepsydra",
      limit: 20,
      offset: 20,
    });
  });

  it("renders an unknown URL Kind as a raw-value FilterBar chip and still queries by it", () => {
    routeMocks.search.kind = "WIDGET";
    render(<GazetteerPage />);

    expect(screen.getByTestId("filter-bar-chip-kind-WIDGET")).toHaveTextContent(
      "KIND: WIDGET",
    );
    expect(routeMocks.useContentIndex).toHaveBeenLastCalledWith({
      q: "atlas",
      tags: ["research"],
      kind: "WIDGET",
      project: "clepsydra",
      limit: 20,
      offset: 20,
    });
  });

  it("gives the text filter an accessible name of Search pages", () => {
    render(<GazetteerPage />);
    expect(screen.getByTestId("filter-bar-input")).toHaveAccessibleName(
      "Search pages",
    );
  });

  it("combines route filters in the authoritative paged query and follows history changes", () => {
    const view = render(<GazetteerPage />);

    expect(routeMocks.useContentIndex).toHaveBeenLastCalledWith({
      q: "atlas",
      tags: ["research"],
      kind: "PROJECT",
      project: "clepsydra",
      limit: 20,
      offset: 20,
    });
    expect(screen.getByTestId("filter-bar-input")).toHaveValue("atlas");

    Object.assign(routeMocks.search, {
      q: "beta",
      tags: ["active"],
      kind: "NOTE",
      project: "atlas",
      sort: "ts",
      page: 1,
    });
    view.rerender(<GazetteerPage />);
    expect(routeMocks.useContentIndex).toHaveBeenLastCalledWith({
      q: "beta",
      tags: ["active"],
      kind: "NOTE",
      project: "atlas",
      limit: 20,
      offset: 0,
    });

    Object.assign(routeMocks.search, completeSearch);
    view.rerender(<GazetteerPage />);
    expect(routeMocks.useContentIndex).toHaveBeenLastCalledWith({
      q: "atlas",
      tags: ["research"],
      kind: "PROJECT",
      project: "clepsydra",
      limit: 20,
      offset: 20,
    });
  });

  it("updates route state for Kind and Project without dropping text or tags", async () => {
    const user = userEvent.setup();
    render(<GazetteerPage />);

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-kind"));
    await user.click(screen.getByTestId("filter-bar-option-kind-NOTE"));
    expect(resolvedSearch()).toEqual({
      ...completeSearch,
      kind: "NOTE",
      page: 1,
    });

    routeMocks.navigate.mockClear();
    await user.click(screen.getByTestId("filter-bar-chip-project-clepsydra"));
    expect(resolvedSearch()).toEqual({
      ...completeSearch,
      project: undefined,
      page: 1,
    });
  });

  it("replaces history on a text-only edit but pushes on a facet toggle", async () => {
    const user = userEvent.setup();
    render(<GazetteerPage />);

    routeMocks.navigate.mockClear();
    await user.type(screen.getByTestId("filter-bar-input"), "!");
    expect(routeMocks.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/gazetteer", replace: true }),
    );

    routeMocks.navigate.mockClear();
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-kind"));
    await user.click(screen.getByTestId("filter-bar-option-kind-NOTE"));
    const call = routeMocks.navigate.mock.calls.at(-1)?.[0];
    expect(call.replace).not.toBe(true);
  });

  it("composes a result tag into route search without opening the row or navigating twice", async () => {
    const user = userEvent.setup();
    Object.assign(routeMocks.search, {
      q: "clep",
      tags: ["pkm"],
      kind: "NOTE",
      project: "clepsydra",
      sort: "title",
      page: 4,
    });
    routeMocks.useContentIndex.mockReturnValue({
      data: {
        items: [
          {
            created_at: "2026-08-01T12:00:00Z",
            description: "Route composition result",
            inferred: false,
            kind: "NOTE",
            links: [],
            path: "notes/research.md",
            project: "clepsydra",
            tags: ["research"],
            computed_tags: [],
            title: "Research",
            updated_at: "2026-08-08T12:00:00Z",
            word_count: 10,
          },
        ],
        total: 100,
      },
      isSuccess: true,
    });
    const view = render(<GazetteerPage />);

    await user.click(
      await screen.findByRole("button", {
        name: "Filter by tag research",
      }),
    );

    expect(routeMocks.openTab).not.toHaveBeenCalled();
    expect(routeMocks.navigate).toHaveBeenCalledOnce();
    expect(routeMocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/gazetteer",
        search: expect.any(Function),
      }),
    );
    const update = routeMocks.navigate.mock.calls.at(-1)?.[0].search as (
      current: typeof completeSearch,
    ) => typeof completeSearch;
    expect(
      update({
        q: "clep",
        tags: ["pkm"],
        kind: "NOTE",
        project: "clepsydra",
        sort: "title",
        page: 4,
      }),
    ).toMatchObject({
      q: "clep",
      tags: ["pkm", "research"],
      kind: "NOTE",
      project: "clepsydra",
      sort: "title",
      page: 1,
    });

    Object.assign(routeMocks.search, { tags: ["pkm", "research"], page: 1 });
    routeMocks.navigate.mockClear();
    view.rerender(<GazetteerPage />);
    const activeTag = screen.getByRole("button", {
      name: "Filter by tag research",
    });
    expect(activeTag).toHaveAttribute("aria-pressed", "true");
    await user.click(activeTag);
    expect(routeMocks.navigate).not.toHaveBeenCalled();
    expect(routeMocks.openTab).not.toHaveBeenCalled();
  });
});
