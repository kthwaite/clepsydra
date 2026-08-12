import type * as ReactQuery from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type * as FeedApi from "#/api/feeds";
import type { components } from "#/api/schema";

type FeedEntry = components["schemas"]["FeedEntryDto"];
type FeedList = components["schemas"]["FeedListResponse"];

const riverMocks = vi.hoisted(() => {
  const NativeRequest = globalThis.Request;
  class BrowserLikeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" ? new URL(input, "https://ui.test") : input,
        init,
      );
    }
  }
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("Request", BrowserLikeRequest);
  vi.stubGlobal("fetch", fetchMock);

  type Page = {
    entries: FeedEntry[];
    next_cursor?: string | null;
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
    NativeRequest,
    fetchMock,
    useRealHooks: false,
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
    patchEntryAsync: vi.fn(),
    patchState: {
      isPending: false,
      error: null as Error | null,
      reset: vi.fn(),
    },
    markEntriesRead: vi.fn(),
    markState: {
      isPending: false,
      error: null as Error | null,
      reset: vi.fn(),
    },
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useInfiniteQuery: (options: never) =>
      riverMocks.useRealHooks
        ? actual.useInfiniteQuery(options)
        : riverMocks.entriesQuery,
  };
});

vi.mock("#/api/feeds", async (importOriginal) => {
  const actual = await importOriginal<typeof FeedApi>();
  return {
    ...actual,
    feedEntriesInfiniteOptions: (filters: never) =>
      riverMocks.useRealHooks
        ? actual.feedEntriesInfiniteOptions(filters)
        : riverMocks.feedEntriesInfiniteOptions(filters),
    useFeeds: () => riverMocks.feedsQuery,
    usePatchFeedEntry: () =>
      riverMocks.useRealHooks
        ? actual.usePatchFeedEntry()
        : {
            mutate: riverMocks.patchEntry,
            mutateAsync: riverMocks.patchEntryAsync,
            ...riverMocks.patchState,
          },
    useMarkFeedEntriesRead: () => ({
      mutate: riverMocks.markEntriesRead,
      mutateAsync: riverMocks.markEntriesRead,
      ...riverMocks.markState,
    }),
  };
});

import { updateCachedEntryPages } from "#/api/feeds";
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
  preference_namespace: "fixture-feed-preferences",
  counts: { unread: 1, all: 1, saved: 0 },
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
  selectedEntryId?: number,
  onSelectEntry = vi.fn(),
) {
  return render(
    <FeedRiver
      filters={filters}
      compact={compact}
      selectedEntryId={selectedEntryId}
      onSelectEntry={onSelectEntry}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  riverMocks.fetchMock.mockReset();
  riverMocks.useRealHooks = false;
  riverMocks.patchState.isPending = false;
  riverMocks.patchState.error = null;
  riverMocks.markState.isPending = false;
  riverMocks.markState.error = null;
  riverMocks.patchEntryAsync.mockImplementation((variables) => {
    riverMocks.patchEntry(variables);
    return Promise.resolve();
  });
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

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("FeedRiver", () => {
  it("selects a full-mode row without mounting inline content and marks unread through the existing patch path", async () => {
    const user = userEvent.setup();
    const onSelectEntry = vi.fn();
    renderRiver({ view: "all" }, false, undefined, onSelectEntry);

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    expect(onSelectEntry).toHaveBeenCalledWith(101);
    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, read: true }),
    );
    expect(screen.queryByText("The complete entry body.")).not.toBeInTheDocument();
  });

  it("marks the selected row current while retaining every loaded row", () => {
    setEntries([
      entry(),
      entry({ id: 102, guid: "entry-102", title: "Earlier dispatch" }),
    ]);
    renderRiver({ view: "all" }, false, 102);

    expect(
      screen.getByRole("article", { name: /earlier dispatch/i }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("article", { name: /cache semantics/i }),
    ).toBeVisible();
  });

  it("preserves loaded pages and scroll position across selected-id rerenders", () => {
    setEntries([
      entry(),
      entry({ id: 102, guid: "entry-102", title: "Earlier dispatch" }),
    ]);
    const page = renderRiver({ view: "all" }, false, 101);
    const river = screen.getByRole("region", { name: "Feed river" });
    river.scrollTop = 173;

    page.rerender(
      <FeedRiver
        filters={{ view: "all" }}
        selectedEntryId={102}
        onSelectEntry={vi.fn()}
      />,
    );

    expect(river).toBe(screen.getByRole("region", { name: "Feed river" }));
    expect(river.scrollTop).toBe(173);
    expect(screen.getByRole("article", { name: /cache semantics/i })).toBeVisible();
    expect(screen.getByRole("article", { name: /earlier dispatch/i })).toBeVisible();
  });

  it("pins an unread selected row through optimistic removal and rollback without moving the scroll container", async () => {
    const deferredPatch = Promise.withResolvers<FeedEntry>();
    riverMocks.patchEntryAsync.mockReturnValue(deferredPatch.promise);
    const onSelectEntry = vi.fn();
    const page = renderRiver(
      { view: "unread" },
      false,
      undefined,
      onSelectEntry,
    );
    const river = screen.getByRole("region", { name: "Feed river" });
    river.scrollTop = 211;

    await userEvent.setup().click(
      screen.getByRole("button", { name: /cache semantics/i }),
    );
    setEntries([]);
    page.rerender(
      <FeedRiver
        filters={{ view: "unread" }}
        selectedEntryId={101}
        onSelectEntry={onSelectEntry}
      />,
    );

    const selected = screen.getByRole("article", { name: /cache semantics/i });
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(selected).toHaveTextContent("Unread entry");
    expect(screen.getByRole("region", { name: "Feed river" })).toBe(river);
    expect(river.scrollTop).toBe(211);
    await act(async () =>
      deferredPatch.reject(new Error("read patch failed")),
    );
    setEntries([entry()]);
    page.rerender(
      <FeedRiver
        filters={{ view: "unread" }}
        selectedEntryId={101}
        onSelectEntry={onSelectEntry}
      />,
    );

    expect(
      screen.getByRole("article", { name: /cache semantics/i }),
    ).toHaveTextContent("Unread entry");
    expect(screen.getByRole("region", { name: "Feed river" })).toBe(river);
    expect(river.scrollTop).toBe(211);
  });

  it("appends a fetched page without replacing the first loaded page", async () => {
    const user = userEvent.setup();
    setEntries([entry()], "cursor-page-2");
    const page = renderRiver({ view: "all" }, false);

    await user.click(screen.getByRole("button", { name: /load more/i }));
    riverMocks.entriesQuery.data = {
      pages: [
        { entries: [entry()], next_cursor: "cursor-page-2" },
        {
          entries: [
            entry({
              id: 88,
              guid: "entry-88",
              title: "Page two dispatch",
              published_at: "2026-08-08T12:00:00Z",
            }),
          ],
          next_cursor: null,
        },
      ],
      pageParams: [undefined, "cursor-page-2"],
    };
    riverMocks.entriesQuery.hasNextPage = false;
    page.rerender(
      <FeedRiver
        filters={{ view: "all" }}
        onSelectEntry={vi.fn()}
      />,
    );

    expect(screen.getByRole("article", { name: /cache semantics/i })).toBeVisible();
    expect(screen.getByRole("article", { name: /page two dispatch/i })).toBeVisible();
  });

  it("keeps compact disclosure and its full-reader continuation", async () => {
    const user = userEvent.setup();
    renderRiver({ view: "all" }, true);

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    expect(screen.getByText("The complete entry body.")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /continue in feeds/i }),
    ).toHaveAttribute("href", "/feeds?view=all");
  });
  it("marks an unread entry read when expanded and exposes a safe original link", async () => {
    const user = userEvent.setup();
    renderRiver({ view: "unread" }, true);

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

  it("hides the visual pip while keeping Read or Unread in the disclosure name and tree", async () => {
    const user = userEvent.setup();
    renderRiver({ view: "unread" }, true);

    const unreadTrigger = screen.getByRole("button", {
      name: /unread entry.*cache semantics/i,
    });
    expect(
      within(unreadTrigger).getByText("Unread entry", { selector: ".sr-only" }),
    ).toBeInTheDocument();
    expect(
      Array.from(unreadTrigger.querySelectorAll('[aria-hidden="true"]')).some(
        (element) => element.classList.contains("h-[7px]"),
      ),
    ).toBe(true);

    await user.click(unreadTrigger);

    const readTrigger = await screen.findByRole("button", {
      name: /^read entry.*cache semantics/i,
    });
    expect(
      within(readTrigger).getByText("Read entry", { selector: ".sr-only" }),
    ).toBeInTheDocument();
    expect(
      Array.from(readTrigger.querySelectorAll('[aria-hidden="true"]')).some(
        (element) => element.classList.contains("h-[7px]"),
      ),
    ).toBe(true);
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

  it.each(["unread", "all", "saved"] as const)(
    "requests the %s river mode through the generated query boundary",
    (view) => {
      renderRiver({ view });

      expect(riverMocks.feedEntriesInfiniteOptions).toHaveBeenCalledWith(
        expect.objectContaining({ view }),
      );
    },
  );

  it("toggles an entry bookmark from the expanded controls", async () => {
    const user = userEvent.setup();
    renderRiver({ view: "all" }, true);
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
    renderRiver({ view: "all" }, true);
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
    renderRiver({ view: "all" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    riverMocks.patchEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /mark unread/i }));

    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, read: false }),
    );
  });

  it("keeps read entries in all, hides them in unread, and restores them when toggled off", async () => {
    const user = userEvent.setup();
    const page = renderRiver({ view: "all" }, true);
    const before = riverMocks.entriesQuery.data;
    if (!before) {
      throw new Error("Expected seeded entry pages");
    }

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    expect(riverMocks.patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, read: true }),
    );

    const all = updateCachedEntryPages(
      before,
      { id: 101, read: true },
      { view: "all" },
    );
    riverMocks.entriesQuery.data = all;
    page.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    expect(
      screen.getByRole("article", { name: /cache semantics/i }),
    ).toBeVisible();

    const unread = updateCachedEntryPages(
      before,
      { id: 101, read: true },
      { view: "unread" },
    );
    riverMocks.entriesQuery.data = unread;
    page.rerender(<FeedRiver filters={{ view: "unread" }} compact />);
    expect(
      screen.queryByRole("article", { name: /cache semantics/i }),
    ).not.toBeInTheDocument();

    riverMocks.entriesQuery.data = all;
    page.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    expect(
      screen.getByRole("article", { name: /cache semantics/i }),
    ).toBeVisible();
    expect(all.pageParams).toEqual(before.pageParams);
    expect(unread.pageParams).toEqual(before.pageParams);
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
    renderRiver({ view: "all" }, true);

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
  it("keeps an expanded unread entry pinned through optimistic removal and refetch", async () => {
    riverMocks.useRealHooks = true;
    const initialPages = {
      pages: [{ entries: [entry()], next_cursor: null }],
      pageParams: [undefined],
    };
    const queryKey = [
      "get",
      "/api/vault/feeds/entries",
      { params: { query: { view: "unread" } } },
    ] as const;
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    client.setQueryData(queryKey, initialPages);
    riverMocks.fetchMock.mockImplementation(async (input, init) => {
      const request =
        input instanceof riverMocks.NativeRequest
          ? input
          : new riverMocks.NativeRequest(input, init);
      if (request.method === "PATCH") {
        const body = (await request.clone().json()) as { read?: boolean };
        return new Response(
          JSON.stringify(entry({ read: body.read ?? baseEntry.read })),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (
        request.method === "GET" &&
        request.url.includes("/api/vault/feeds/entries")
      ) {
        return new Response(
          JSON.stringify({ entries: [], next_cursor: null }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(
        `Unexpected feed request: ${request.method} ${request.url}`,
      );
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <FeedRiver filters={{ view: "unread" }} compact />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    await waitFor(() => {
      expect(
        client.getQueryData<typeof initialPages>(queryKey)?.pages[0].entries,
      ).toEqual([]);
    });
    await waitFor(() => {
      expect(
        riverMocks.fetchMock.mock.calls.some(([input]) => {
          const request =
            input instanceof riverMocks.NativeRequest
              ? input
              : new riverMocks.NativeRequest(input);
          return (
            request.method === "GET" &&
            request.url.includes("/api/vault/feeds/entries")
          );
        }),
      ).toBe(true);
    });
    expect(screen.getByText("The complete entry body.")).toBeVisible();
    const pinnedArticle = screen.getByRole("article", {
      name: /cache semantics/i,
    });
    await waitFor(() => {
      const disclosure = within(pinnedArticle).getByRole("button", {
        name: /^read entry.*cache semantics/i,
      });
      expect(
        within(disclosure).getByText("Read entry", { selector: ".sr-only" }),
      ).toBeInTheDocument();
      expect(
        Array.from(disclosure.querySelectorAll('[aria-hidden="true"]')).some(
          (element) => element.classList.contains("h-[7px]"),
        ),
      ).toBe(true);
      expect(
        within(pinnedArticle).getByRole("button", {
          name: /^mark unread$/i,
        }),
      ).toBeEnabled();
    });
    await user.click(
      within(pinnedArticle).getByRole("button", { name: /^mark unread$/i }),
    );
    await waitFor(() => {
      const patchRequests = riverMocks.fetchMock.mock.calls
        .map(([input]) =>
          input instanceof riverMocks.NativeRequest
            ? input
            : new riverMocks.NativeRequest(input),
        )
        .filter((request) => request.method === "PATCH");
      expect(patchRequests).toHaveLength(2);
    });
    const patchRequests = riverMocks.fetchMock.mock.calls
      .map(([input]) =>
        input instanceof riverMocks.NativeRequest
          ? input
          : new riverMocks.NativeRequest(input),
      )
      .filter((request) => request.method === "PATCH");
    await expect(patchRequests.at(-1)?.clone().json()).resolves.toEqual(
      expect.objectContaining({ read: false }),
    );

    await user.click(screen.getByRole("button", { expanded: true }));
    expect(
      screen.queryByText("The complete entry body."),
    ).not.toBeInTheDocument();
  });

  it("mounts content and actions only for the single expanded entry", async () => {
    const user = userEvent.setup();
    setEntries([
      entry(),
      entry({
        id: 102,
        guid: "entry-102",
        title: "Second dispatch",
        content_html: "<p>Second private body.</p>",
        url: "https://two.example/post",
      }),
    ]);
    renderRiver({ view: "all" }, true);

    expect(
      screen.queryByText("The complete entry body."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Second private body.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open original/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    expect(screen.getByText("The complete entry body.")).toBeVisible();
    expect(screen.queryByText("Second private body.")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /open original/i }),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /second dispatch/i }));
    expect(
      screen.queryByText("The complete entry body."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Second private body.")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: /open original/i }),
    ).toHaveLength(1);
  });

  it.each([
    "javascript:alert(document.domain)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "custom-protocol://publisher/action",
  ])("omits the original action for unsafe URL %s", async (url) => {
    const user = userEvent.setup();
    setEntries([entry({ read: true, url })]);
    renderRiver({ view: "all" }, true);

    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    expect(screen.queryByRole("link", { name: /open original/i })).toBeNull();
  });

  it("surfaces a mark-all failure and disables the pending boundary action", async () => {
    const user = userEvent.setup();
    const view = renderRiver();
    await user.click(screen.getByRole("button", { name: /mark all read/i }));

    riverMocks.markState.isPending = true;
    view.rerender(<FeedRiver filters={{ view: "unread" }} />);
    expect(
      screen.getByRole("button", { name: /mark all read|marking/i }),
    ).toBeDisabled();

    riverMocks.markState.isPending = false;
    riverMocks.markState.error = new Error("Bulk mark failed");
    view.rerender(<FeedRiver filters={{ view: "unread" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Bulk mark failed");
  });

  it("surfaces mark-on-expand failures without collapsing the entry", async () => {
    const user = userEvent.setup();
    const view = renderRiver({ view: "unread" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));

    riverMocks.patchState.error = new Error("Read state could not be saved");
    view.rerender(<FeedRiver filters={{ view: "unread" }} compact />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Read state could not be saved",
    );
    expect(screen.getByText("The complete entry body.")).toBeVisible();
  });

  it.each([
    [/mark unread/i, "Read state failed"],
    [/bookmark cache semantics/i, "Bookmark failed"],
  ] as const)(
    "surfaces a failed expanded-entry action and disables it while pending",
    async (actionName, message) => {
      const user = userEvent.setup();
      setEntries([entry({ read: true })]);
      const view = renderRiver({ view: "all" }, true);
      await user.click(
        screen.getByRole("button", { name: /cache semantics/i }),
      );
      await user.click(screen.getByRole("button", { name: actionName }));

      riverMocks.patchState.isPending = true;
      view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
      expect(screen.getByRole("button", { name: actionName })).toBeDisabled();

      riverMocks.patchState.isPending = false;
      riverMocks.patchState.error = new Error(message);
      view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
      expect(screen.getByRole("alert")).toHaveTextContent(message);
    },
  );

  it("retains the tag draft and editor through pending and failure, closing only on success", async () => {
    let resolvePatch!: () => void;
    const pendingPatch = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    riverMocks.patchEntryAsync.mockImplementation((variables) => {
      riverMocks.patchEntry(variables);
      return pendingPatch;
    });
    const user = userEvent.setup();
    setEntries([entry({ read: true })]);
    const view = renderRiver({ view: "all" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    await user.click(screen.getByRole("button", { name: /edit tags/i }));
    const tags = screen.getByRole("textbox", {
      name: /tags for cache semantics/i,
    });
    await user.clear(tags);
    await user.type(tags, "systems, reading");
    await user.click(screen.getByRole("button", { name: /save tags/i }));

    riverMocks.patchState.isPending = true;
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    expect(
      screen.getByRole("textbox", { name: /tags for cache semantics/i }),
    ).toHaveValue("systems, reading");
    expect(
      screen.getByRole("textbox", { name: /tags for cache semantics/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /save tags|saving/i }),
    ).toBeDisabled();

    riverMocks.patchState.isPending = false;
    riverMocks.patchState.error = new Error("Tags could not be saved");
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tags could not be saved",
    );
    expect(
      screen.getByRole("textbox", { name: /tags for cache semantics/i }),
    ).toHaveValue("systems, reading");

    riverMocks.patchState.error = null;
    const callbackCall = riverMocks.patchEntry.mock.calls.find(
      (call) => typeof call[1]?.onSuccess === "function",
    );
    await act(async () => {
      callbackCall?.[1]?.onSuccess?.(entry({ tags: ["systems", "reading"] }));
      resolvePatch();
      await pendingPatch;
    });
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: /tags for cache semantics/i }),
      ).toBeNull();
    });
  });
  it("reconciles an explicit read success into an expanded pinned snapshot", async () => {
    const updated = entry({ read: false });
    riverMocks.patchEntry.mockImplementation((_variables, options) => {
      options?.onSuccess?.(updated);
    });
    riverMocks.patchEntryAsync.mockResolvedValue(updated);
    const user = userEvent.setup();
    setEntries([entry({ read: true })]);
    const view = renderRiver({ view: "all" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    setEntries([]);
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);

    await user.click(screen.getByRole("button", { name: /^mark unread$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^mark read$/i }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", {
          name: /unread entry.*cache semantics/i,
        }),
      ).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("reconciles bookmark success into an expanded pinned snapshot", async () => {
    const updated = entry({ read: true, bookmarked: true });
    riverMocks.patchEntry.mockImplementation((_variables, options) => {
      options?.onSuccess?.(updated);
    });
    riverMocks.patchEntryAsync.mockResolvedValue(updated);
    const user = userEvent.setup();
    setEntries([entry({ read: true })]);
    const view = renderRiver({ view: "all" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    setEntries([]);
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);

    await user.click(
      screen.getByRole("button", { name: /bookmark cache semantics/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /remove bookmark from cache semantics/i,
        }),
      ).toBeVisible();
      expect(screen.getByText("Saved")).toBeVisible();
      expect(screen.getByText("The complete entry body.")).toBeVisible();
    });
  });

  it("reconciles tag success into an expanded pinned snapshot", async () => {
    const updated = entry({ read: true, tags: ["systems", "reading"] });
    riverMocks.patchEntryAsync.mockResolvedValue(updated);
    const user = userEvent.setup();
    setEntries([entry({ read: true })]);
    const view = renderRiver({ view: "all" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    setEntries([]);
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    await user.click(screen.getByRole("button", { name: /edit tags/i }));
    const tags = screen.getByRole("textbox", {
      name: /tags for cache semantics/i,
    });
    await user.clear(tags);
    await user.type(tags, "systems, reading");

    await user.click(screen.getByRole("button", { name: /save tags/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: /tags for cache semantics/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("#systems")).toBeVisible();
      expect(screen.getByText("#reading")).toBeVisible();
      expect(screen.queryByText("#rust")).not.toBeInTheDocument();
      expect(screen.getByText("The complete entry body.")).toBeVisible();
    });
  });

  it("preserves the exact pinned snapshot when an explicit mutation rolls back", async () => {
    const failure = new Error("Tags could not be saved");
    riverMocks.patchEntryAsync.mockRejectedValue(failure);
    const user = userEvent.setup();
    setEntries([entry({ read: true, bookmarked: true })]);
    const view = renderRiver({ view: "all" }, true);
    await user.click(screen.getByRole("button", { name: /cache semantics/i }));
    setEntries([]);
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);
    await user.click(screen.getByRole("button", { name: /edit tags/i }));
    const tags = screen.getByRole("textbox", {
      name: /tags for cache semantics/i,
    });
    await user.clear(tags);
    await user.type(tags, "systems");

    await user.click(screen.getByRole("button", { name: /save tags/i }));
    riverMocks.patchState.error = failure;
    view.rerender(<FeedRiver filters={{ view: "all" }} compact />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tags could not be saved",
    );
    expect(screen.getByText("#rust")).toBeVisible();
    expect(screen.queryByText("#systems")).not.toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^mark unread$/i }),
    ).toBeVisible();
    expect(screen.getByText("The complete entry body.")).toBeVisible();
  });
});
