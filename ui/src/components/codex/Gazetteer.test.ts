import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KINDS, kindLabel } from "#/lib/kind";
import { useGazetteerStore } from "#/store/gazetteer";
import { Gazetteer, toggleInSet } from "./Gazetteer";

const {
  contentQueryState,
  contentState,
  layoutState,
  openTabMock,
  routeBridge,
  useContentIndexMock,
} = vi.hoisted(() => {
  const contentState = {
    items: [] as Array<Record<string, unknown>>,
    total: 0,
  };
  return {
    contentQueryState: {
      data: contentState as typeof contentState | undefined,
      error: null as Error | null,
      isSuccess: true,
    },
    contentState,
    layoutState: { mobile: true },
    openTabMock: vi.fn(),
    routeBridge: { openWorkspace: undefined as (() => void) | undefined },
    useContentIndexMock: vi.fn(),
  };
});

vi.mock("#/api/index", () => ({
  useContentIndex: (...args: unknown[]) => {
    useContentIndexMock(...args);
    return contentQueryState;
  },
  useTags: () => ({ data: [{ tag: "research", count: 1 }] }),
}));
vi.mock("#/api/pages", () => ({
  useAssignBulk: () => ({ isPending: false, mutate: vi.fn() }),
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
    await user.click(
      within(filters).getByRole("button", { name: "Filter by research" }),
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
    expect(
      within(restored).getByRole("button", { name: "Filter by research" }),
    ).toHaveAttribute("aria-pressed", "true");
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
});
