import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedEntry = components["schemas"]["FeedEntryDto"];
type FeedList = components["schemas"]["FeedListResponse"];

const riverMocks = vi.hoisted(() => {
  type Page = {
    entries: FeedEntry[];
    next_cursor: string | null;
  };

  const entriesQuery: {
    data: { pages: Page[]; pageParams: Array<string | undefined> } | undefined;
    isPending: boolean;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: Mock;
  } = {
    data: undefined,
    isPending: false,
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };

  return {
    entriesQuery,
    feedsQuery: {
      data: undefined as FeedList | undefined,
      isPending: false,
      isLoading: false,
      isError: false,
      error: null as Error | null,
    },
    feedEntriesInfiniteOptions: vi.fn(),
    patchEntry: vi.fn(),
    markEntriesRead: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => riverMocks.entriesQuery,
}));

vi.mock("#/api/feeds", () => ({
  feedEntriesInfiniteOptions: riverMocks.feedEntriesInfiniteOptions,
  useFeeds: () => riverMocks.feedsQuery,
  usePatchFeedEntry: () => ({
    mutate: riverMocks.patchEntry,
    mutateAsync: riverMocks.patchEntry,
    isPending: false,
  }),
  useMarkFeedEntriesRead: () => ({
    mutate: riverMocks.markEntriesRead,
    mutateAsync: riverMocks.markEntriesRead,
    isPending: false,
  }),
}));

import { FeedRiver } from "#/components/codex/FeedRiver";

const baseEntry: FeedEntry = {
  id: 101,
  feed_id: 7,
  guid: "entry-101",
  title: "Cache semantics",
  url: "https://one.example/posts/cache-semantics",
  author: "Kit",
  content_html: "<p>The complete entry body.</p>",
  published_at: "2026-08-09T12:00:00Z",
  fetched_at: "2026-08-09T12:01:00Z",
  read: false,
  bookmarked: false,
  tags: ["rust"],
};

const feeds = {
  diagnostics: [],
  groups: [
    {
      name: "Engineering",
      feeds: [
        {
          id: 7,
          title: "One Example",
          title_override: null,
          url: "https://one.example/feed.xml",
          fetch_url: "https://one.example/feed.xml",
          site_url: "https://one.example",
          group: "Engineering",
          tags: ["rust"],
          last_fetch_at: "2026-08-09T12:05:00Z",
          next_fetch_at: "2026-08-09T13:05:00Z",
          error_count: 0,
          last_error: null,
        },
      ],
    },
  ],
  manifest_revision: "revision-1",
};

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return { ...baseEntry, ...overrides };
}

function setEntries(entries: FeedEntry[], nextCursor: string | null = null) {
  riverMocks.entriesQuery.data = {
    pages: [{ entries, next_cursor: nextCursor }],
    pageParams: [undefined],
  };
  riverMocks.entriesQuery.hasNextPage = nextCursor !== null;
}

function renderRiver(
  filters: {
    view: "unread" | "all" | "saved";
    group?: string;
    feed?: number;
    tag?: string;
  } = { view: "unread" },
  compact = false,
) {
  return render(<FeedRiver filters={filters} compact={compact} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  riverMocks.feedEntriesInfiniteOptions.mockImplementation((filters) => ({
    queryKey: [
      "get",
      "/api/vault/feeds/entries",
      { params: { query: filters } },
    ],
  }));
  riverMocks.feedsQuery.data = feeds;
  riverMocks.feedsQuery.isPending = false;
  riverMocks.feedsQuery.isLoading = false;
  riverMocks.feedsQuery.isError = false;
  riverMocks.feedsQuery.error = null;
  riverMocks.entriesQuery.data = undefined;
  riverMocks.entriesQuery.isPending = false;
  riverMocks.entriesQuery.isLoading = false;
  riverMocks.entriesQuery.isError = false;
  riverMocks.entriesQuery.error = null;
  riverMocks.entriesQuery.hasNextPage = false;
  riverMocks.entriesQuery.isFetchingNextPage = false;
  setEntries([entry()]);
});

describe("FeedRiver", () => {
  it("marks an unread entry read when expanded and exposes a safe original link", async () => {
    const user = userEvent.setup();
    renderRiver();

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, read: true }),
    );
    expect(screen.getByText("The complete entry body.")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /open original/i }),
    ).toHaveAttribute("href", "https://one.example/posts/cache-semantics");
    expect(
      screen.getByRole("link", { name: /open original/i }),
    ).toHaveAttribute("target", "_blank");
    expect(
      screen.getByRole("link", { name: /open original/i }),
    ).toHaveAttribute("rel", "noreferrer");
  });

  it("groups newest-first entries under calendar-day headings", () => {
    setEntries([
      entry(),
      entry({
        id: 102,
        guid: "entry-102",
        title: "Same day",
        published_at: "2026-08-09T09:00:00Z",
      }),
      entry({
        id: 103,
        guid: "entry-103",
        title: "Previous day",
        published_at: "2026-08-08T12:00:00Z",
      }),
    ]);

    renderRiver({ view: "all" });

    expect(
      screen.getAllByRole("heading", { name: "9 August 2026" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("heading", { name: "8 August 2026" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /cache semantics/i }),
    ).toAppearBefore(screen.getByRole("button", { name: /previous day/i }));
  });

  it("renders a named loading status", () => {
    riverMocks.entriesQuery.data = undefined;
    riverMocks.entriesQuery.isPending = true;
    riverMocks.entriesQuery.isLoading = true;

    renderRiver();

    expect(
      screen.getByRole("status", { name: /loading feed entries/i }),
    ).toBeVisible();
  });

  it("renders a useful query error", () => {
    riverMocks.entriesQuery.data = undefined;
    riverMocks.entriesQuery.isError = true;
    riverMocks.entriesQuery.error = new Error("feed database unavailable");

    renderRiver();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "feed database unavailable",
    );
  });

  it("renders an empty state without removing the river surface", () => {
    setEntries([]);

    renderRiver({ view: "saved" });

    expect(screen.getByText(/no saved entries/i)).toBeVisible();
    expect(screen.getByRole("region", { name: /feed river/i })).toBeVisible();
  });

  it.each([
    "unread",
    "all",
    "saved",
  ] as const)("requests the %s river mode through the generated query boundary", (view) => {
    renderRiver({ view });

    expect(riverMocks.feedEntriesInfiniteOptions).toHaveBeenCalledWith(
      expect.objectContaining({ view }),
    );
  });

  it("toggles an entry bookmark from the expanded controls", async () => {
    const user = userEvent.setup();
    renderRiver({ view: "all" });
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    await user.click(
      screen.getByRole("button", { name: /bookmark cache semantics/i }),
    );

    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, bookmarked: true }),
    );
  });

  it("edits normalized entry tags through named controls", async () => {
    const user = userEvent.setup();
    renderRiver({ view: "all" });
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    await user.click(screen.getByRole("button", { name: /edit tags/i }));

    const tags = screen.getByRole("textbox", {
      name: /tags for cache semantics/i,
    });
    await user.clear(tags);
    await user.type(tags, "systems, reading");
    await user.click(screen.getByRole("button", { name: /save tags/i }));

    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, tags: ["systems", "reading"] }),
    );
  });

  it("offers an explicit mark-unread action for a read entry", async () => {
    const user = userEvent.setup();
    setEntries([entry({ read: true })]);
    renderRiver({ view: "all" });
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    riverMocks.patchEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /mark unread/i }));

    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, read: false }),
    );
  });

  it("bounds mark-all-read at the newest visible cursor and preserves active filters", async () => {
    const user = userEvent.setup();
    setEntries([
      entry(),
      entry({
        id: 102,
        guid: "entry-102",
        title: "Earlier",
        published_at: "2026-08-09T11:00:00Z",
      }),
    ]);
    renderRiver({
      view: "unread",
      group: "Engineering",
      feed: 7,
      tag: "rust",
    });

    await user.click(screen.getByRole("button", { name: /mark all read/i }));

    expect(riverMocks.markEntriesRead).toHaveBeenCalledWith({
      before: "2026-08-09T12:00:00Z|101",
      feed: 7,
      group: "Engineering",
      tag: "rust",
    });
  });

  it("loads the next cursor page in the full river", async () => {
    const user = userEvent.setup();
    setEntries([entry()], "2026-08-08T12:00:00Z|88");
    renderRiver({ view: "all" });

    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(riverMocks.entriesQuery.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hands compact continuation to the full reader without fetching in place", async () => {
    const user = userEvent.setup();
    setEntries([entry()], "2026-08-08T12:00:00Z|88");
    renderRiver({ view: "unread", group: "Engineering", tag: "rust" }, true);

    const continuation = screen.getByRole("link", {
      name: /continue.*feeds|open full reader|view all entries/i,
    });
    const href = new URL(
      continuation.getAttribute("href") ?? "",
      "https://ui.test",
    );
    expect(href.pathname).toBe("/feeds");
    expect(href.searchParams.get("view")).toBe("unread");
    expect(href.searchParams.get("group")).toBe("Engineering");
    expect(href.searchParams.get("tag")).toBe("rust");

    await user.click(continuation);
    expect(riverMocks.entriesQuery.fetchNextPage).not.toHaveBeenCalled();
  });

  it("uses named articles and controls that remain operable in a narrow flow", async () => {
    const user = userEvent.setup();
    setEntries([
      entry(),
      entry({ id: 102, guid: "entry-102", title: "Second dispatch" }),
    ]);
    renderRiver({ view: "all" });

    const first = screen.getByRole("article", { name: /cache semantics/i });
    const second = screen.getByRole("article", { name: /second dispatch/i });
    expect(first).toBeVisible();
    expect(second).toBeVisible();

    await user.click(
      within(first).getByRole("button", { name: /cache semantics/i }),
    );
    expect(
      within(first).getByRole("link", { name: /open original/i }),
    ).toBeVisible();
    await waitFor(() => expect(riverMocks.patchEntry).toHaveBeenCalled());
  });
});
