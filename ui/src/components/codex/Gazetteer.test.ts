import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KINDS, kindLabel } from "#/lib/kind";
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
    await user.type(
      within(filters).getByRole("searchbox", { name: "Search pages" }),
      "Al",
    );
    const tagPicker = within(filters).getByRole("combobox", {
      name: "Filter by tags",
    });
    await user.type(tagPicker, "res");
    await user.click(
      within(filters).getByRole("option", { name: "#research" }),
    );
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
    expect(
      within(restored).getByRole("searchbox", { name: "Search pages" }),
    ).toHaveValue("Al");
    expect(within(restored).getByText("#research")).toBeVisible();
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
      ).getByRole("searchbox", { name: "Search pages" }),
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
    const filters = {
      query: "",
      selectedTags: [],
      sort: "ts" as const,
      page: 2,
      onQueryChange: vi.fn(),
      onSelectedTagsChange: vi.fn(),
      onKindChange: vi.fn(),
      onProjectChange: vi.fn(),
      onSortChange: vi.fn(),
      onPageChange,
    };
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
  it("offers the shared Kind and Project vocabularies through accessible desktop filters", async () => {
    const user = userEvent.setup();
    layoutState.mobile = false;
    render(createElement(Gazetteer));

    await user.click(screen.getByRole("button", { name: "Filter by kind" }));
    for (const kind of KINDS) {
      expect(
        screen.getByRole("option", { name: kindLabel(kind) }),
      ).toBeVisible();
    }
    await user.click(screen.getByRole("option", { name: "PROJECT" }));

    const project = screen.getByRole("combobox", {
      name: "Filter by project",
    });
    await user.click(project);
    expect(screen.getByRole("option", { name: "atlas" })).toBeVisible();
    expect(screen.getByRole("option", { name: "clepsydra" })).toBeVisible();
  });

  it("renders one controlled desktop tag picker instead of the complete tag rail", async () => {
    const user = userEvent.setup();
    const onSelectedTagsChange = vi.fn();
    layoutState.mobile = false;
    render(
      createElement(Gazetteer, {
        filters: {
          query: "",
          selectedTags: [],
          sort: "ts",
          page: 1,
          onQueryChange: vi.fn(),
          onSelectedTagsChange,
          onKindChange: vi.fn(),
          onProjectChange: vi.fn(),
          onSortChange: vi.fn(),
          onPageChange: vi.fn(),
        },
      }),
    );

    const picker = screen.getByRole("combobox", { name: "Filter by tags" });
    expect(
      screen.getAllByRole("combobox", { name: "Filter by tags" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Filter by research" }),
    ).not.toBeInTheDocument();

    await user.type(picker, "res");
    await user.click(screen.getByRole("option", { name: "#research" }));
    expect(onSelectedTagsChange).toHaveBeenCalledWith(["research"]);
  });

  it("keeps unknown URL tags removable while rejecting unknown drafts", async () => {
    const user = userEvent.setup();
    const onSelectedTagsChange = vi.fn();
    layoutState.mobile = false;
    render(
      createElement(Gazetteer, {
        filters: {
          query: "",
          selectedTags: ["legacy-url-tag"],
          sort: "ts",
          page: 1,
          onQueryChange: vi.fn(),
          onSelectedTagsChange,
          onKindChange: vi.fn(),
          onProjectChange: vi.fn(),
          onSortChange: vi.fn(),
          onPageChange: vi.fn(),
        },
      }),
    );

    expect(screen.getByText("#legacy-url-tag")).toBeVisible();
    await user.type(
      screen.getByRole("combobox", { name: "Filter by tags" }),
      "unknown{Enter}",
    );
    expect(onSelectedTagsChange).not.toHaveBeenCalled();

    const selectedTags = screen.getByRole("grid", {
      name: "Filter by tags",
    });
    await user.click(within(selectedTags).getByRole("button"));
    expect(onSelectedTagsChange).toHaveBeenCalledWith([]);
  });

  it("retries failed tag suggestions without clearing selected route tags", async () => {
    const user = userEvent.setup();
    layoutState.mobile = false;
    tagQueryState.error = new Error("offline");
    render(
      createElement(Gazetteer, {
        filters: {
          query: "",
          selectedTags: ["research", "legacy-url-tag"],
          sort: "ts",
          page: 1,
          onQueryChange: vi.fn(),
          onSelectedTagsChange: vi.fn(),
          onKindChange: vi.fn(),
          onProjectChange: vi.fn(),
          onSortChange: vi.fn(),
          onPageChange: vi.fn(),
        },
      }),
    );

    await user.type(
      screen.getByRole("combobox", { name: "Filter by tags" }),
      "res",
    );
    const selectedTagGrid = screen.getByRole("grid", {
      name: "Filter by tags",
    });
    expect(within(selectedTagGrid).getByText("#legacy-url-tag")).toBeVisible();
    expect(within(selectedTagGrid).getByText("#research")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Retry tag suggestions" }),
    );
    expect(tagQueryState.refetch).toHaveBeenCalledOnce();
    expect(within(selectedTagGrid).getByText("#legacy-url-tag")).toBeVisible();
    expect(within(selectedTagGrid).getByText("#research")).toBeVisible();
  });

  it("announces loading tag suggestions without clearing selected route tags", async () => {
    const user = userEvent.setup();
    layoutState.mobile = false;
    tagQueryState.isFetching = true;
    render(
      createElement(Gazetteer, {
        filters: {
          query: "",
          selectedTags: ["legacy-url-tag"],
          sort: "ts",
          page: 1,
          onQueryChange: vi.fn(),
          onSelectedTagsChange: vi.fn(),
          onKindChange: vi.fn(),
          onProjectChange: vi.fn(),
          onSortChange: vi.fn(),
          onPageChange: vi.fn(),
        },
      }),
    );

    await user.type(
      screen.getByRole("combobox", { name: "Filter by tags" }),
      "res",
    );
    expect(screen.getByText("Loading tag suggestions…")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByText("#legacy-url-tag")).toBeVisible();
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
    expect(
      screen.getByRole("button", { name: "✕ 1 selected" }),
    ).toBeVisible();

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
