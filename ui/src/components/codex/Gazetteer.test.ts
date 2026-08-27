import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSIGNABLE_KINDS,
  KINDS,
  kindLabel,
  sortKindsByLabel,
} from "#/lib/kind";
import { useGazetteerStore } from "#/store/gazetteer";
import { Gazetteer, toggleInSet } from "./Gazetteer";

const {
  bulkMutateMock,
  contentQueryState,
  contentState,
  layoutState,
  openTabMock,
  routeBridge,
  tagQueryState,
  useContentIndexMock,
} = vi.hoisted(() => {
  const contentState = {
    items: [] as Array<Record<string, unknown>>,
    total: 0,
  };
  return {
    bulkMutateMock: vi.fn(),
    contentQueryState: {
      data: contentState as typeof contentState | undefined,
      error: null as Error | null,
      isSuccess: true,
    },
    contentState,
    layoutState: { mobile: true },
    openTabMock: vi.fn(),
    routeBridge: { openWorkspace: undefined as (() => void) | undefined },
    tagQueryState: {
      data: [
        { tag: "research", count: 4, computed_count: 0 },
        { tag: "rust", count: 2, computed_count: 0 },
      ],
      isFetching: false,
      error: null as Error | null,
      refetch: vi.fn(),
    },
    useContentIndexMock: vi.fn(),
  };
});

vi.mock("#/api/index", () => ({
  useContentIndex: (...args: unknown[]) => {
    useContentIndexMock(...args);
    return contentQueryState;
  },
  useTags: () => tagQueryState,
}));
vi.mock("#/api/pages", () => ({
  useAssignBulk: () => ({ isPending: false, mutate: bulkMutateMock }),
}));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => layoutState.mobile,
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab:
    () =>
    (...args: unknown[]) => {
      openTabMock(...args);
      routeBridge.openWorkspace?.();
    },
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["atlas", "clepsydra"],
}));

function GazetteerNavigationHarness() {
  const [route, setRoute] = useState<"gazetteer" | "workspace">("gazetteer");
  routeBridge.openWorkspace = () => setRoute("workspace");

  return route === "gazetteer"
    ? createElement(Gazetteer)
    : createElement(
        "button",
        { type: "button", onClick: () => setRoute("gazetteer") },
        "Return to Gazetteer",
      );
}

function makeContentEntry(index: number) {
  const number = index + 1;
  const alpha = index === 0;
  return {
    created_at: "2026-08-01T12:00:00Z",
    description: alpha ? "First note" : `Note ${number}`,
    inferred: false,
    kind: "NOTE",
    links: [],
    path: alpha ? "notes/alpha.md" : `notes/page-${number}.md`,
    project: alpha ? "Atlas" : null,
    tags: alpha ? ["research"] : [],
    title: alpha ? "Alpha" : `Page ${number}`,
    updated_at: "2026-08-08T12:00:00Z",
    word_count: 300 + number,
  };
}

/** Builds a directly-passed `GazetteerFilters` prop for controller-mode tests. */
function makeFilters(
  overrides: Partial<Parameters<typeof Gazetteer>[0]["filters"]> = {},
) {
  return {
    filterState: { text: "", facets: {} },
    sort: "ts" as const,
    page: 1,
    onFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    onPageChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  openTabMock.mockClear();
  layoutState.mobile = true;
  useContentIndexMock.mockClear();
  routeBridge.openWorkspace = undefined;
  tagQueryState.data = [
    { tag: "research", count: 4, computed_count: 0 },
    { tag: "rust", count: 2, computed_count: 0 },
  ];
  tagQueryState.isFetching = false;
  tagQueryState.error = null;
  tagQueryState.refetch.mockReset();
  bulkMutateMock.mockReset();
  contentState.items = Array.from({ length: 25 }, (_, index) =>
    makeContentEntry(index),
  );
  contentQueryState.data = contentState;
  contentQueryState.error = null;
  contentQueryState.isSuccess = true;
  useGazetteerStore.setState({
    query: "",
    selectedTags: [],
    kind: undefined,
    project: undefined,
    sort: "ts",
    page: 1,
    routeTag: undefined,
  });
});

describe("toggleInSet", () => {
  it("adds a value that is absent", () => {
    const result = toggleInSet(new Set(["a"]), "b");
    expect([...result].sort()).toEqual(["a", "b"]);
  });

  it("removes a value that is present", () => {
    const result = toggleInSet(new Set(["a", "b"]), "a");
    expect([...result]).toEqual(["b"]);
  });

  it("returns a NEW set (does not mutate the input)", () => {
    const input = new Set(["a"]);
    const result = toggleInSet(input, "b");
    expect(result).not.toBe(input);
    expect([...input]).toEqual(["a"]);
  });
});

describe("Gazetteer controller", () => {
  it("restores query, tag, and sort after opening a Folio and returning", async () => {
    const user = userEvent.setup();
    render(createElement(GazetteerNavigationHarness));

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const filters = screen.getByRole("dialog", { name: "Gazetteer filters" });
    await user.type(within(filters).getByTestId("filter-bar-input"), "Al");
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    await user.click(screen.getByTestId("filter-bar-option-tags-research"));
    // multi-select keeps the add-filter popover open; close it explicitly.
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(within(filters).getByRole("radio", { name: "Title" }));
    await user.click(
      within(filters).getByRole("button", { name: "Close filters" }),
    );

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/alpha.md", "Alpha");

    await user.click(
      screen.getByRole("button", { name: "Return to Gazetteer" }),
    );
    await user.click(screen.getByRole("button", { name: "Filters · 2" }));

    const restored = screen.getByRole("dialog", {
      name: "Gazetteer filters",
    });
    expect(within(restored).getByTestId("filter-bar-input")).toHaveValue("Al");
    expect(
      within(restored).getByTestId("filter-bar-chip-tags-research"),
    ).toBeVisible();
    expect(
      within(restored).getByRole("radio", { name: "Title" }),
    ).toBeChecked();
  });

  it("paginates mobile rows accessibly, persists the page through Folio navigation, and resets when filters reduce results", async () => {
    const user = userEvent.setup();
    render(createElement(GazetteerNavigationHarness));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Page 1 of 2 · 25 matches",
    );
    expect(
      within(screen.getByRole("list", { name: "Vault pages" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(screen.getByRole("button", { name: "Next page" })).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Page 2 of 2 · 25 matches",
    );
    expect(
      within(screen.getByRole("list", { name: "Vault pages" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Open Page 21" }));
    await user.click(
      screen.getByRole("button", { name: "Return to Gazetteer" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Page 2 of 2 · 25 matches",
    );

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.type(
      within(
        screen.getByRole("dialog", { name: "Gazetteer filters" }),
      ).getByTestId("filter-bar-input"),
      "Alpha",
    );
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Gazetteer filters" }),
      ).getByRole("button", { name: "Close filters" }),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Page 1 of 1 · 1 match",
    );
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Alpha" })).toBeVisible();
  });

  it("retains a requested page until the authoritative query resolves", () => {
    const onPageChange = vi.fn();
    const filters = makeFilters({ page: 2, onPageChange });
    contentQueryState.data = undefined;
    contentQueryState.isSuccess = false;

    const view = render(createElement(Gazetteer, { filters }));

    expect(useContentIndexMock).toHaveBeenLastCalledWith({
      q: undefined,
      tags: undefined,
      kind: undefined,
      project: undefined,
      limit: 20,
      offset: 20,
    });
    expect(onPageChange).not.toHaveBeenCalled();

    contentState.items = [];
    contentState.total = 0;
    contentQueryState.data = contentState;
    contentQueryState.isSuccess = true;
    view.rerender(createElement(Gazetteer, { filters }));

    expect(onPageChange).toHaveBeenCalledOnce();
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("offers the shared Kind and Project vocabularies through the desktop FilterBar", async () => {
    const user = userEvent.setup();
    layoutState.mobile = false;
    const onFilterChange = vi.fn();
    render(
      createElement(Gazetteer, { filters: makeFilters({ onFilterChange }) }),
    );

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-kind"));
    for (const kind of KINDS) {
      expect(
        screen.getByTestId(`filter-bar-option-kind-${kind}`),
      ).toHaveTextContent(kindLabel(kind));
    }
    const kindOptionIds = screen
      .getAllByTestId(/^filter-bar-option-kind-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(kindOptionIds).toEqual(
      sortKindsByLabel(KINDS).map((k) => `filter-bar-option-kind-${k}`),
    );
    await user.click(screen.getByTestId("filter-bar-option-kind-PROJECT"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { kind: ["PROJECT"] },
    });

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-project"));
    expect(screen.getByTestId("filter-bar-option-project-atlas")).toBeVisible();
    expect(
      screen.getByTestId("filter-bar-option-project-clepsydra"),
    ).toBeVisible();
  });

  it("adds a tag facet through the desktop FilterBar and reflects it as a chip", async () => {
    const user = userEvent.setup();
    layoutState.mobile = false;
    const onFilterChange = vi.fn();
    render(
      createElement(Gazetteer, { filters: makeFilters({ onFilterChange }) }),
    );

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    await user.click(screen.getByTestId("filter-bar-option-tags-research"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { tags: ["research"] },
    });
  });

  it("shows an unknown URL tag as a removable chip", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    layoutState.mobile = false;
    render(
      createElement(Gazetteer, {
        filters: makeFilters({
          filterState: { text: "", facets: { tags: ["legacy-url-tag"] } },
          onFilterChange,
        }),
      }),
    );

    const chip = screen.getByTestId("filter-bar-chip-tags-legacy-url-tag");
    expect(chip).toBeVisible();
    await user.click(chip);
    expect(onFilterChange).toHaveBeenCalledWith({ text: "", facets: {} });
  });

  it("offers bulk kind assignment as an alphabetical combobox without quotation", async () => {
    const user = userEvent.setup();
    layoutState.mobile = false;
    render(createElement(Gazetteer));

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(
      screen.getByRole("combobox", { name: "Set kind for selection" }),
    );

    expect(screen.queryByRole("option", { name: "QUOTE" })).toBeNull();
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(
      sortKindsByLabel(ASSIGNABLE_KINDS).map((k) => kindLabel(k)),
    );

    await user.click(screen.getByRole("option", { name: "BOOK" }));
    expect(bulkMutateMock).toHaveBeenCalledWith(
      {
        body: {
          paths: ["notes/alpha.md"],
          kind: "BOOK",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("accepts an atomic moved-and-unchanged bulk response and clears the selection", async () => {
    layoutState.mobile = false;
    bulkMutateMock.mockImplementation(
      (
        _request: unknown,
        options: {
          onSuccess: (response: {
            moved: [string, string][];
            unchanged: string[];
          }) => void;
        },
      ) => {
        options.onSuccess({
          moved: [["notes/alpha.md", "quotes/alpha.md"]],
          unchanged: [],
        });
      },
    );
    const user = userEvent.setup();
    render(createElement(Gazetteer));

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(screen.getByRole("button", { name: "✕ 1 selected" })).toBeVisible();

    await user.type(
      screen.getByRole("combobox", { name: "Project" }),
      "Atlas{Enter}",
    );

    expect(bulkMutateMock).toHaveBeenCalledWith(
      {
        body: {
          paths: ["notes/alpha.md"],
          project: "Atlas",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(
      screen.queryByRole("button", { name: "✕ 1 selected" }),
    ).not.toBeInTheDocument();
  });
});
