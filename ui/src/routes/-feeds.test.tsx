import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedEntry = components["schemas"]["FeedEntryDto"];

const routeMocks = vi.hoisted(() => ({
  search: {
    view: "saved" as "unread" | "all" | "saved",
    group: "Engineering" as string | undefined,
    feed: 7 as number | undefined,
    tag: "rust" as string | undefined,
    manage: false,
    entry: undefined as number | undefined,
  },
  navigate: vi.fn(),
  mobile: false,
  useFeedEntry: vi.fn(),
  fetchMock: vi.fn(),
  detailQuery: {
    data: undefined as FeedEntry | undefined,
    isPending: false,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  patchEntryAsync: vi.fn(),
  patchState: {
    isPending: false,
    error: null as unknown,
    reset: vi.fn(),
  },
}));

const directEntry: FeedEntry = {
  id: 501,
  feed_id: 7,
  guid: "direct-501",
  title: "Direct archive entry",
  url: "https://outside.example/direct",
  author: "Archive Author",
  content_html: "<p>Stored direct body.</p>",
  published_at: "2026-08-10T09:00:00Z",
  fetched_at: "2026-08-10T09:01:00Z",
  read: true,
  bookmarked: false,
  tags: ["rust"],
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => routeMocks.search,
  }),
  useNavigate: () => routeMocks.navigate,
}));

vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => routeMocks.mobile,
}));

vi.mock("#/api/feeds", () => ({
  useFeeds: () => ({
    data: {
      diagnostics: [],
      groups: [
        {
          name: "Engineering",
          feeds: [
            {
              id: 7,
              title: "One Example",
              title_override: "Source Ledger",
              url: "https://one.example/feed.xml",
              fetch_url: "https://one.example/feed.xml",
              site_url: "https://one.example",
              group: "Engineering",
              tags: ["rust"],
              last_fetch_at: null,
              next_fetch_at: null,
              error_count: 0,
              last_error: null,
            },
          ],
        },
      ],
    },
  }),
  useFeedEntry: (id?: number) => {
    routeMocks.useFeedEntry(id);
    return routeMocks.detailQuery;
  },
  usePatchFeedEntry: () => ({
    mutateAsync: routeMocks.patchEntryAsync,
    ...routeMocks.patchState,
  }),
}));

vi.mock("#/components/codex/Card", () => ({
  Card: ({ label, children }: { label: string; children: ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
}));

vi.mock("#/components/codex/FeedRiver", () => ({
  FeedRiver: ({
    selectedEntryId,
    onSelectEntry,
  }: {
    selectedEntryId?: number;
    onSelectEntry?: (id: number) => void;
  }) => (
    <section
      aria-label="Feed river fixture"
      data-selected-entry={selectedEntryId}
    >
      <button type="button" onClick={() => onSelectEntry?.(501)}>
        Select direct entry
      </button>
      <span>Loaded list entry</span>
    </section>
  ),
}));

vi.mock("#/components/codex/FeedManagement", () => ({
  FeedManagement: () => <div aria-label="Feed management fixture" />,
}));

import { Route } from "#/routes/feeds";

const FeedsPage = Route.options.component as () => ReactNode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", routeMocks.fetchMock);
  routeMocks.search.view = "saved";
  routeMocks.search.group = "Engineering";
  routeMocks.search.feed = 7;
  routeMocks.search.tag = "rust";
  routeMocks.search.manage = false;
  routeMocks.search.entry = undefined;
  routeMocks.mobile = false;
  routeMocks.detailQuery.data = undefined;
  routeMocks.detailQuery.isPending = false;
  routeMocks.detailQuery.isLoading = false;
  routeMocks.detailQuery.isError = false;
  routeMocks.detailQuery.error = null;
  routeMocks.patchState.isPending = false;
  routeMocks.patchState.error = null;
  routeMocks.patchEntryAsync.mockResolvedValue(directEntry);
});

describe("feeds route controls", () => {
  it("defaults an omitted or unknown view to all", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch({})).toMatchObject({ view: "all" });
    expect(validateSearch({ view: "not-a-view" })).toMatchObject({ view: "all" });
  });

  it.each([23, "23"])("accepts positive integer entry %s", (entry) => {
    const validateSearch = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => { entry?: number };
    expect(validateSearch({ entry })).toMatchObject({ entry: 23 });
  });

  it.each([0, -1, Number.NaN, 1.5, "1.5", "nope", {}, true])(
    "rejects invalid entry %s",
    (entry) => {
      const validateSearch = Route.options.validateSearch as (
        search: Record<string, unknown>,
      ) => { entry?: number };
      expect(validateSearch({ entry }).entry).toBeUndefined();
    },
  );

  it("selecting changes only entry while preserving all filters and manage state", async () => {
    render(<FeedsPage />);

    await userEvent.setup().click(
      screen.getByRole("button", { name: /select direct entry/i }),
    );

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toEqual({
      ...routeMocks.search,
      entry: 501,
    });
  });

  it("explicit back removes only entry", async () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    render(<FeedsPage />);

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Back to entries" }),
    );

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toEqual({
      ...routeMocks.search,
      entry: undefined,
    });
  });

  it("replaces only entry after a confirmed 404", async () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.isError = true;
    routeMocks.detailQuery.error = { status: 404, error: "entry not found" };
    render(<FeedsPage />);

    await waitFor(() => expect(routeMocks.navigate).toHaveBeenCalledTimes(1));
    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      replace?: boolean;
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.replace).toBe(true);
    expect(navigation.search(routeMocks.search)).toEqual({
      ...routeMocks.search,
      entry: undefined,
    });
  });

  it("retains selection and exposes retry for a transient detail error", async () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.isError = true;
    routeMocks.detailQuery.error = { status: 503, error: "archive unavailable" };
    render(<FeedsPage />);

    expect(routeMocks.navigate).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(routeMocks.detailQuery.refetch).toHaveBeenCalledTimes(1);
    expect(routeMocks.navigate).not.toHaveBeenCalled();
  });

  it("renders independent river and reader scroll regions on desktop", () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    render(<FeedsPage />);

    expect(screen.getByRole("region", { name: "Entry list" })).toHaveClass(
      "overflow-y-auto",
    );
    expect(screen.getByRole("region", { name: "Feed reader" })).toHaveClass(
      "overflow-y-auto",
    );
    expect(screen.getByRole("region", { name: "Entry list" })).not.toHaveAttribute(
      "hidden",
    );
    expect(screen.getByRole("region", { name: "Feed reader" })).not.toHaveAttribute(
      "hidden",
    );
  });

  it("shows mobile list without selection and detail with an explicit back control", () => {
    routeMocks.mobile = true;
    const page = render(<FeedsPage />);

    expect(screen.getByRole("region", { name: "Entry list" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Feed reader" })).toBeNull();

    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    page.rerender(<FeedsPage />);

    expect(screen.queryByRole("region", { name: "Entry list" })).toBeNull();
    expect(screen.getByRole("region", { name: "Feed reader" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to entries" })).toBeVisible();
  });

  it("keeps the mobile river mounted but inaccessible while detail is selected", () => {
    routeMocks.mobile = true;
    const page = render(<FeedsPage />);
    const riverFixture = screen.getByLabelText("Feed river fixture");

    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    page.rerender(<FeedsPage />);

    expect(screen.getByLabelText("Feed river fixture", { selector: "[hidden] *" })).toBe(
      riverFixture,
    );
    expect(screen.queryByRole("region", { name: "Entry list" })).toBeNull();
    expect(riverFixture.closest("[hidden]")).not.toBeNull();
  });

  it("renders a direct URL detail outside loaded list pages without iframe or source fetch", () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    const page = render(<FeedsPage />);

    expect(screen.getByRole("article", { name: "Direct archive entry" })).toHaveTextContent(
      "Stored direct body.",
    );
    expect(screen.getByText("Loaded list entry")).toBeVisible();
    expect(routeMocks.useFeedEntry).toHaveBeenCalledWith(501);
    expect(page.container.querySelector("iframe")).not.toBeInTheDocument();
    expect(routeMocks.fetchMock).not.toHaveBeenCalled();
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
