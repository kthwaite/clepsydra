import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  useContentIndex: vi.fn(
    (
      ..._args: unknown[]
    ): {
      data?: { items: never[]; total: number };
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
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["atlas", "clepsydra"],
}));

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

describe("Gazetteer route filters", () => {
  it("validates the complete bookmarkable query", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch(completeSearch)).toEqual(completeSearch);
  });

  it("preserves an explicit unknown Kind and surfaces the rejected query", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch({ ...completeSearch, kind: "RECIPE" })).toEqual({
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
    expect(screen.getByRole("searchbox", { name: "Search pages" })).toHaveValue(
      "atlas",
    );

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

    await user.click(screen.getByRole("button", { name: "Filter by kind" }));
    await user.click(screen.getByRole("option", { name: "NOTE" }));
    expect(resolvedSearch()).toEqual({
      ...completeSearch,
      kind: "NOTE",
      page: 1,
    });

    routeMocks.navigate.mockClear();
    await user.click(screen.getByRole("button", { name: /clear.*project/i }));
    expect(resolvedSearch()).toEqual({
      ...completeSearch,
      project: undefined,
      page: 1,
    });
  });
});
