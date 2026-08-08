import { createElement, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGazetteerStore } from "#/store/gazetteer";
import { Gazetteer, toggleInSet } from "./Gazetteer";

const { openTabMock, routeBridge } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  routeBridge: { openWorkspace: undefined as (() => void) | undefined },
}));

vi.mock("#/api/index", () => ({
  useContentIndex: () => ({
    data: {
      items: [
        {
          created_at: "2026-08-01T12:00:00Z",
          description: "First note",
          inferred: false,
          kind: "NOTE",
          links: [],
          path: "notes/alpha.md",
          project: "Atlas",
          tags: ["research"],
          title: "Alpha",
          updated_at: "2026-08-08T12:00:00Z",
          word_count: 321,
        },
      ],
    },
  }),
  useTags: () => ({ data: [{ tag: "research", count: 1 }] }),
}));
vi.mock("#/api/pages", () => ({
  useAssignBulk: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => true }));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => (...args: unknown[]) => {
    openTabMock(...args);
    routeBridge.openWorkspace?.();
  },
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));

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

beforeEach(() => {
  openTabMock.mockClear();
  routeBridge.openWorkspace = undefined;
  useGazetteerStore.setState({
    query: "",
    selectedTags: [],
    sort: "ts",
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
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/alpha.md",
      "Alpha",
    );

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
});
