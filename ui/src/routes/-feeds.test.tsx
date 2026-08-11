import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  search: {
    view: "saved" as "unread" | "all" | "saved",
    group: undefined as string | undefined,
    feed: undefined as number | undefined,
    tag: "rust" as string | undefined,
    manage: false,
  },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
}));

vi.mock("#/api/feeds", () => ({
  useFeeds: () => ({ data: { diagnostics: [], groups: [] } }),
}));

vi.mock("#/components/codex/Card", () => ({
  Card: ({ label, children }: { label: string; children: ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
}));

vi.mock("#/components/codex/FeedRiver", () => ({
  FeedRiver: () => <div aria-label="Feed river fixture" />,
}));

vi.mock("#/components/codex/FeedManagement", () => ({
  FeedManagement: () => <div aria-label="Feed management fixture" />,
}));

import { Route } from "#/routes/feeds";

const FeedsPage = Route.options.component as () => ReactNode;

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.search.view = "saved";
  routeMocks.search.group = undefined;
  routeMocks.search.feed = undefined;
  routeMocks.search.tag = "rust";
  routeMocks.search.manage = false;
});

describe("feeds route controls", () => {
  it("defaults an omitted or unknown view to all", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch({})).toMatchObject({ view: "all" });
    expect(validateSearch({ view: "not-a-view" })).toMatchObject({
      view: "all",
    });
  });

  it("maps Hide read to unread and toggles it off without changing other search state", async () => {
    const user = userEvent.setup();
    routeMocks.search.view = "all";
    const page = render(<FeedsPage />);

    const hideRead = screen.getByRole("button", { name: /hide read/i });
    expect(hideRead).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^saved$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(hideRead);
    const enabled = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(enabled.search(routeMocks.search)).toEqual({
      ...routeMocks.search,
      view: "unread",
    });

    routeMocks.search.view = "unread";
    page.rerender(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /hide read/i }));
    const disabled = routeMocks.navigate.mock.calls[1]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(disabled.search(routeMocks.search)).toEqual({
      ...routeMocks.search,
      view: "all",
    });
  });

  it("keeps a local tag draft and navigates once only when Enter submits it", async () => {
    const user = userEvent.setup();
    render(<FeedsPage />);
    const tag = screen.getByRole("textbox", { name: /^tag$/i });

    await user.clear(tag);
    await user.type(tag, "  systems  ");

    expect(tag).toHaveValue("  systems  ");
    expect(routeMocks.navigate).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");

    expect(routeMocks.navigate).toHaveBeenCalledTimes(1);
    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toEqual(
      expect.objectContaining({ tag: "systems" }),
    );
  });

  it("composes inside the shell without adding a second main landmark", () => {
    render(
      <main aria-label="Application content">
        <FeedsPage />
      </main>,
    );

    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("synchronizes the tag draft when browser history changes the URL search", () => {
    const view = render(<FeedsPage />);
    const tag = screen.getByRole("textbox", { name: /^tag$/i });
    expect(tag).toHaveValue("rust");

    routeMocks.search.tag = "systems";
    view.rerender(<FeedsPage />);
    expect(tag).toHaveValue("systems");

    routeMocks.search.tag = undefined;
    view.rerender(<FeedsPage />);
    expect(tag).toHaveValue("");
  });
});
