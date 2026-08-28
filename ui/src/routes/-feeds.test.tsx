import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedEntry = components["schemas"]["FeedEntryDto"];

const routeMocks = vi.hoisted(() => ({
  featureFlags: { academic: true, feeds: true },
  search: {
    view: "saved" as "unread" | "all" | "saved",
    group: ["Engineering"] as string[] | undefined,
    ungrouped: false,
    feed: [7] as number[] | undefined,
    tag: "rust" as string | undefined,
    manage: false,
    entry: undefined as number | undefined,
  },
  riverHasSelected: true,
  navigate: vi.fn(),
  mobile: false,
  useFeedEntry: vi.fn(),
  useFeeds: vi.fn(),
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
  captureAsync: vi.fn(),
  captureState: {
    isPending: false,
    error: null as unknown,
    reset: vi.fn(),
  },
  openTodayJournal: vi.fn(),
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
  useLocation: () => ({ pathname: "/feeds" }),
  useRouterState: ({
    select,
  }: {
    select: (state: { matches: unknown[] }) => unknown;
  }) => select({ matches: [{ staticData: { codexView: "feeds" } }] }),
}));
vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => routeMocks.featureFlags,
}));

vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => routeMocks.mobile,
}));

vi.mock("#/components/codex/DesktopCodexFrame", () => ({
  DesktopCodexFrame: () => <header />,
}));

vi.mock("#/components/codex/MobileCodexFrame", () => ({
  MobileCodexFrame: () => <header />,
}));

vi.mock("#/api/feeds", () => ({
  useFeeds: routeMocks.useFeeds.mockImplementation(() => ({
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
        {
          name: "",
          feeds: [
            {
              id: 8,
              title: "Unfiled Example",
              title_override: "Loose Source",
              url: "https://loose.example/feed.xml",
              fetch_url: "https://loose.example/feed.xml",
              site_url: "https://loose.example",
              group: "",
              tags: ["ops"],
              last_fetch_at: null,
              next_fetch_at: null,
              error_count: 0,
              last_error: null,
            },
          ],
        },
        {
          name: "__ungrouped__",
          feeds: [
            {
              id: 9,
              title: "Literal Sentinel Example",
              title_override: "Literal Sentinel Source",
              url: "https://literal.example/feed.xml",
              fetch_url: "https://literal.example/feed.xml",
              site_url: "https://literal.example",
              group: "__ungrouped__",
              tags: [],
              last_fetch_at: null,
              next_fetch_at: null,
              error_count: 0,
              last_error: null,
            },
          ],
        },
      ],
    },
  })),
  useFeedEntry: (id?: number) => {
    routeMocks.useFeedEntry(id);
    return routeMocks.detailQuery;
  },
  usePatchFeedEntry: () => ({
    mutateAsync: routeMocks.patchEntryAsync,
    ...routeMocks.patchState,
  }),
}));

vi.mock("#/api/journal", () => ({
  useQuickCapture: () => ({
    mutateAsync: routeMocks.captureAsync,
    ...routeMocks.captureState,
  }),
}));

vi.mock("#/hooks/useOpenTodayJournal", () => ({
  useOpenTodayJournal: () => routeMocks.openTodayJournal,
}));

vi.mock("#/components/codex/FeedRiver", () => ({
  FeedRiver: ({
    filters,
    selectedEntryId,
    onSelectEntry,
  }: {
    filters: { group?: string[]; feed?: number[]; tag?: string };
    selectedEntryId?: number;
    onSelectEntry?: (id: number) => void;
  }) => (
    <section
      aria-label="Feed river fixture"
      data-selected-entry={selectedEntryId}
      data-group={filters.group?.join(",") ?? "__all__"}
      data-feed={filters.feed?.join(",") ?? "__all__"}
      data-tag={filters.tag ?? "__all__"}
    >
      {routeMocks.riverHasSelected ? (
        <button
          type="button"
          data-feed-entry-id="501"
          aria-current={selectedEntryId === 501 ? "true" : undefined}
          onClick={() => onSelectEntry?.(501)}
        >
          Select direct entry
        </button>
      ) : null}
      <span>Loaded list entry</span>
    </section>
  ),
}));

vi.mock("#/components/codex/FeedManagement", () => ({
  FeedManagement: () => <div />,
}));

import { CodexFrame } from "#/components/codex/CodexFrame";
import { Route } from "#/routes/feeds";

const FeedsPage = Route.options.component as () => ReactNode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", routeMocks.fetchMock);
  routeMocks.featureFlags.academic = true;
  routeMocks.featureFlags.feeds = true;
  routeMocks.search.view = "saved";
  routeMocks.search.group = ["Engineering"];
  routeMocks.search.ungrouped = false;
  routeMocks.search.feed = [7];
  routeMocks.search.tag = "rust";
  routeMocks.search.manage = false;
  routeMocks.search.entry = undefined;
  routeMocks.mobile = false;
  routeMocks.detailQuery.data = undefined;
  routeMocks.detailQuery.isPending = false;
  routeMocks.detailQuery.isLoading = false;
  routeMocks.detailQuery.isError = false;
  routeMocks.riverHasSelected = true;
  routeMocks.detailQuery.error = null;
  routeMocks.patchState.isPending = false;
  routeMocks.patchState.error = null;
  routeMocks.patchEntryAsync.mockResolvedValue(directEntry);
  routeMocks.captureState.isPending = false;
  routeMocks.captureState.error = null;
  routeMocks.captureAsync.mockResolvedValue({ path: "journals/20260815.md" });
});

describe("feeds route controls", () => {
  it("renders not found without mounting Feed API hooks when disabled", () => {
    routeMocks.featureFlags.feeds = false;

    render(<FeedsPage />);

    expect(screen.getByText("404 · folio missing")).toBeVisible();
    expect(routeMocks.useFeeds).not.toHaveBeenCalled();
    expect(routeMocks.useFeedEntry).not.toHaveBeenCalled();
  });

  it("defaults an omitted or unknown view to all", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch({} as any)).toMatchObject({ view: "all" });
    expect(validateSearch({ view: "not-a-view" } as any)).toMatchObject({
      view: "all",
    });
  });

  it("validateSearch keeps the ungrouped sentinel and a real __ungrouped__-named group distinct", () => {
    const validateSearch = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => { group?: string[]; ungrouped: boolean; feed?: number[] };
    expect(validateSearch({ ungrouped: true })).toMatchObject({
      group: undefined,
      ungrouped: true,
    });
    expect(validateSearch({ group: "__ungrouped__" })).toMatchObject({
      group: ["__ungrouped__"],
      ungrouped: false,
    });
  });

  it("validateSearch reads repeated group and feed parameters as lists", () => {
    const validateSearch = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => { group?: string[]; feed?: number[] };
    expect(
      validateSearch({ group: ["News", "Work"], feed: ["7", 9] }),
    ).toMatchObject({ group: ["News", "Work"], feed: [7, 9] });
    expect(validateSearch({ group: [""], feed: ["nope"] })).toMatchObject({
      group: undefined,
      feed: undefined,
    });
  });

  it("selects a real sentinel-like group name through the group select and clears it by toggling", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    const page = render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "__ungrouped__" }));
    await user.keyboard("{Escape}");

    const namedNavigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    const namedSearch = namedNavigation.search(routeMocks.search);
    expect(namedSearch).toMatchObject({
      group: ["__ungrouped__"],
      ungrouped: false,
    });

    Object.assign(routeMocks.search, namedSearch);
    page.rerender(<FeedsPage />);
    expect(
      screen.getByRole("button", { name: /group filter/i }),
    ).toHaveTextContent("__ungrouped__");
    expect(screen.getByLabelText("Feed river fixture")).toHaveAttribute(
      "data-group",
      "__ungrouped__",
    );

    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "__ungrouped__" }));
    await user.keyboard("{Escape}");
    const clearedNavigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(clearedNavigation.search(routeMocks.search)).toMatchObject({
      group: undefined,
    });
  });

  it("adds a feed facet through the feed select, keyed by id, labeled by its override title", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    const page = render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /feed filter/i }));
    await user.click(screen.getByRole("button", { name: "Source Ledger" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    const nextSearch = navigation.search(routeMocks.search);
    expect(nextSearch).toMatchObject({ feed: [7] });

    Object.assign(routeMocks.search, nextSearch);
    page.rerender(<FeedsPage />);
    expect(
      screen.getByRole("button", { name: /feed filter/i }),
    ).toHaveTextContent("Source Ledger");
    expect(screen.getByLabelText("Feed river fixture")).toHaveAttribute(
      "data-feed",
      "7",
    );
  });

  it("selects several feeds at once and hands the river every one", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = [7];
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    const page = render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /feed filter/i }));
    await user.click(screen.getByRole("button", { name: "Loose Source" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    const nextSearch = navigation.search(routeMocks.search);
    expect(nextSearch).toMatchObject({ feed: [7, 8] });

    Object.assign(routeMocks.search, nextSearch);
    page.rerender(<FeedsPage />);
    expect(
      screen.getByRole("button", { name: /feed filter/i }),
    ).toHaveTextContent(/2 selected/i);
    expect(screen.getByLabelText("Feed river fixture")).toHaveAttribute(
      "data-feed",
      "7,8",
    );
  });

  it("narrows the feed options to the selected groups' feeds", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = ["Engineering"];
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /feed filter/i }));

    expect(screen.getByRole("button", { name: "Source Ledger" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Loose Source" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Literal Sentinel Source" }),
    ).toBeNull();
  });

  it("unions the feed options across several selected groups", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = ["Engineering", "__ungrouped__"];
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /feed filter/i }));

    expect(screen.getByRole("button", { name: "Source Ledger" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Literal Sentinel Source" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Loose Source" })).toBeNull();
  });

  it("offers every feed when no group is selected", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /feed filter/i }));

    expect(screen.getByRole("button", { name: "Source Ledger" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Loose Source" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Literal Sentinel Source" }),
    ).toBeVisible();
  });

  it("drops an orphaned feed when a later group change no longer contains it", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = [8];
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    const page = render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    const afterGroup = navigation.search(routeMocks.search);
    expect(afterGroup).toMatchObject({
      group: ["Engineering"],
      feed: undefined,
    });

    Object.assign(routeMocks.search, afterGroup);
    page.rerender(<FeedsPage />);
    expect(screen.getByLabelText("Feed river fixture")).toHaveAttribute(
      "data-feed",
      "__all__",
    );
  });

  it("keeps a selected feed whose group is still selected", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = ["Engineering"];
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = [7];
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "__ungrouped__" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      group: ["Engineering", "__ungrouped__"],
      feed: [7],
    });
  });

  it("closes a selected entry that the new group filter excludes", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Ungrouped" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      ungrouped: true,
      entry: undefined,
    });
  });

  it("keeps a selected entry that the new group filter still contains", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      group: ["Engineering"],
      entry: 501,
    });
  });

  it("closes a selected entry that the new feed filter excludes", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /feed filter/i }));
    await user.click(screen.getByRole("button", { name: "Loose Source" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      feed: [8],
      entry: undefined,
    });
  });

  it("closes a selected entry that the new tag filter excludes", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /tag filter/i }));
    await user.click(screen.getByRole("button", { name: "ops" }));

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      tag: "ops",
      entry: undefined,
    });
  });

  it("leaves a selected entry alone while its detail is still unloaded", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Ungrouped" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({ entry: 501 });
  });

  it("omits the back control on desktop and focuses the reader region instead", async () => {
    routeMocks.search.entry = undefined;
    routeMocks.detailQuery.data = directEntry;
    const page = render(<FeedsPage />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /select direct entry/i }));
    routeMocks.search.entry = 501;
    page.rerender(<FeedsPage />);

    expect(
      screen.queryByRole("button", { name: "Back to entries" }),
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Feed reader" }),
    );
  });

  it("clears every facet from one control while keeping the view and the open entry", async () => {
    routeMocks.search.view = "unread";
    routeMocks.search.group = ["Engineering"];
    routeMocks.search.ungrouped = true;
    routeMocks.search.feed = [7];
    routeMocks.search.tag = "rust";
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /clear filters/i }));

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      group: undefined,
      ungrouped: false,
      feed: undefined,
      tag: undefined,
      view: "unread",
      entry: 501,
    });
  });

  it("offers no clear control while every facet is empty", () => {
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    render(<FeedsPage />);

    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it.each([
    ["group", { group: ["Engineering"] }],
    ["ungrouped", { ungrouped: true }],
    ["feed", { feed: [7] }],
    ["tag", { tag: "rust" }],
  ] as const)(
    "offers the clear control for an active %s facet",
    (_label, facet) => {
      routeMocks.search.group = undefined;
      routeMocks.search.ungrouped = false;
      routeMocks.search.feed = undefined;
      routeMocks.search.tag = undefined;
      Object.assign(routeMocks.search, facet);

      render(<FeedsPage />);

      expect(
        screen.getByRole("button", { name: /clear filters/i }),
      ).toBeVisible();
    },
  );

  it("keeps a selected entry open when only the view changes", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /hide read/i }));

    const navigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      view: "unread",
      entry: 501,
    });
  });

  it("shows Ungrouped for a URL with ungrouped=true, selects it, and clears it", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = true;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    const page = render(<FeedsPage />);

    expect(
      screen.getByRole("button", { name: /group filter/i }),
    ).toHaveTextContent(/ungrouped/i);
    expect(screen.getByLabelText("Feed river fixture")).toHaveAttribute(
      "data-group",
      "",
    );

    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Ungrouped" }));
    await user.keyboard("{Escape}");
    const clearedNavigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(clearedNavigation.search(routeMocks.search)).toMatchObject({
      group: undefined,
      ungrouped: false,
    });

    routeMocks.search.ungrouped = false;
    page.rerender(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Ungrouped" }));
    await user.keyboard("{Escape}");
    const selectedNavigation = routeMocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(selectedNavigation.search(routeMocks.search)).toMatchObject({
      group: undefined,
      ungrouped: true,
    });
  });

  it("never writes the ungrouped sentinel value to the URL", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);
    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Ungrouped" }));
    await user.keyboard("{Escape}");

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    const nextSearch = navigation.search(routeMocks.search);
    expect(nextSearch.group).toBeUndefined();
    expect(nextSearch.ungrouped).toBe(true);
  });

  it("distinguishes picking the real group named __ungrouped__ from picking Ungrouped", async () => {
    routeMocks.search.view = "all";
    routeMocks.search.group = undefined;
    routeMocks.search.ungrouped = false;
    routeMocks.search.feed = undefined;
    routeMocks.search.tag = undefined;

    const user = userEvent.setup();
    render(<FeedsPage />);

    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "__ungrouped__" }));
    await user.keyboard("{Escape}");
    const namedNavigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(namedNavigation.search(routeMocks.search)).toMatchObject({
      group: ["__ungrouped__"],
      ungrouped: false,
    });

    routeMocks.navigate.mockClear();

    await user.click(screen.getByRole("button", { name: /group filter/i }));
    await user.click(screen.getByRole("button", { name: "Ungrouped" }));
    await user.keyboard("{Escape}");
    const sentinelNavigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(sentinelNavigation.search(routeMocks.search)).toMatchObject({
      ungrouped: true,
      group: undefined,
    });
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

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /select direct entry/i }));

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toEqual({
      ...routeMocks.search,
      entry: 501,
    });
  });

  it("explicit back removes only entry", async () => {
    routeMocks.mobile = true;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    render(<FeedsPage />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to entries" }));

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
    routeMocks.detailQuery.error = {
      status: 503,
      error: "archive unavailable",
    };
    render(<FeedsPage />);

    expect(routeMocks.navigate).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /retry/i }));
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
    expect(
      screen.getByRole("region", { name: "Entry list" }),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByRole("region", { name: "Feed reader" }),
    ).not.toHaveAttribute("hidden");
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
    expect(
      screen.getByRole("button", { name: "Back to entries" }),
    ).toBeVisible();
  });

  it("keeps the mobile river mounted but inaccessible while detail is selected", () => {
    routeMocks.mobile = true;
    const page = render(<FeedsPage />);
    const riverFixture = screen.getByLabelText("Feed river fixture");

    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    page.rerender(<FeedsPage />);

    expect(
      screen.getByLabelText("Feed river fixture", { selector: "[hidden] *" }),
    ).toBe(riverFixture);
    expect(screen.queryByRole("region", { name: "Entry list" })).toBeNull();
    expect(riverFixture.closest("[hidden]")).not.toBeNull();
  });

  it("hands focus from a selected mobile row to the reader and back to that row", async () => {
    routeMocks.mobile = true;
    const page = render(<FeedsPage />);
    const row = screen.getByRole("button", { name: /select direct entry/i });

    await userEvent.setup().click(row);
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    page.rerender(<FeedsPage />);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to entries" }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to entries" }));
    routeMocks.search.entry = undefined;
    page.rerender(<FeedsPage />);

    expect(document.activeElement).toBe(row);
  });

  it("restores the mobile list scroll after the explicit back action", async () => {
    routeMocks.mobile = true;
    const page = render(
      <CodexFrame forceView="feeds">
        <FeedsPage />
      </CodexFrame>,
    );
    const main = screen.getByRole("main");
    main.scrollTop = 700;

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /select direct entry/i }));
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    page.rerender(
      <CodexFrame forceView="feeds">
        <FeedsPage />
      </CodexFrame>,
    );
    main.scrollTop = 0;

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to entries" }));
    routeMocks.search.entry = undefined;
    page.rerender(
      <CodexFrame forceView="feeds">
        <FeedsPage />
      </CodexFrame>,
    );

    expect(main.scrollTop).toBe(700);
  });

  it("cancels stale mobile scroll restoration when the feed route unmounts", async () => {
    routeMocks.mobile = true;
    let scheduledFrame: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledFrame = callback;
        return 42;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const page = render(
      <main>
        <FeedsPage />
      </main>,
    );
    const main = screen.getByRole("main");
    main.scrollTop = 700;

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /select direct entry/i }));
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    page.rerender(
      <main>
        <FeedsPage />
      </main>,
    );
    main.scrollTop = 0;
    routeMocks.search.entry = undefined;
    page.rerender(
      <main>
        <FeedsPage />
      </main>,
    );
    expect(main.scrollTop).toBe(700);
    expect(scheduledFrame).toBeTypeOf("function");

    page.rerender(
      <main>
        <div>Next route</div>
      </main>,
    );
    main.scrollTop = 0;
    scheduledFrame?.(performance.now());

    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(screen.getByRole("main")).toBe(main);
    expect(main.scrollTop).toBe(0);
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("hands browser-history focus to the list region when the selected row is unavailable", () => {
    routeMocks.mobile = true;
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    const page = render(<FeedsPage />);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to entries" }),
    );

    routeMocks.riverHasSelected = false;
    routeMocks.search.entry = undefined;
    page.rerender(<FeedsPage />);

    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Entry list" }),
    );
  });

  it.each([[undefined], [[99]]])(
    "resolves source from entry feed id when the feed filter is %s",
    (feed) => {
      routeMocks.search.feed = feed;
      routeMocks.search.entry = 501;
      routeMocks.detailQuery.data = directEntry;

      render(<FeedsPage />);

      expect(
        screen.getByRole("article", { name: "Direct archive entry" }),
      ).toHaveTextContent("Source Ledger");
    },
  );

  it("bounds long reader content inside the real CodexFrame track", () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = {
      ...directEntry,
      content_html: `<p>${"Long stored dispatch. ".repeat(600)}</p>`,
    };
    render(
      <CodexFrame forceView="feeds">
        <FeedsPage />
      </CodexFrame>,
    );

    const main = screen.getByRole("main");
    const routePage = main.querySelector("[data-feeds-page]");
    const reader = screen.getByRole("region", { name: "Feed reader" });
    expect(routePage).toHaveClass("md:h-full");
    expect(routePage).toHaveClass("md:contain-paint");
    expect(routePage).not.toHaveClass("md:h-dvh");
    expect(reader.parentElement).toHaveClass("md:h-full");
    expect(reader).toHaveClass("md:h-full", "overflow-y-auto");
    expect(screen.getByRole("region", { name: "Entry list" })).toHaveClass(
      "overflow-y-auto",
    );
  });

  it("renders a direct URL detail outside loaded list pages without iframe or source fetch", () => {
    routeMocks.search.entry = 501;
    routeMocks.detailQuery.data = directEntry;
    const page = render(<FeedsPage />);

    expect(
      screen.getByRole("article", { name: "Direct archive entry" }),
    ).toHaveTextContent("Stored direct body.");
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

  it("offers tag options derived from loaded feed tags, deduped and sorted", async () => {
    routeMocks.search.tag = undefined;
    const user = userEvent.setup();
    render(<FeedsPage />);

    await user.click(screen.getByRole("button", { name: /tag filter/i }));
    const options = screen
      .getAllByRole("button", { pressed: false })
      .filter((option) => option.textContent === "rust");
    expect(options).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "rust" }));
    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      tag: "rust",
    });
  });

  it("composes inside the shell without adding a second main landmark", () => {
    render(
      <main aria-label="Application content">
        <FeedsPage />
      </main>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("clears the tag param when its option is toggled off", async () => {
    const user = userEvent.setup();
    render(<FeedsPage />);

    await user.click(screen.getByRole("button", { name: /tag filter/i }));
    await user.click(screen.getByRole("button", { name: "rust" }));

    const navigation = routeMocks.navigate.mock.calls[0]?.[0] as {
      search: (current: typeof routeMocks.search) => typeof routeMocks.search;
    };
    expect(navigation.search(routeMocks.search)).toMatchObject({
      tag: undefined,
    });
  });
});
