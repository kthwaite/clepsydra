import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  type EntryFilters,
  feedEntriesInfiniteOptions,
  updateCachedEntryPages,
  useDeleteFeed,
  useImportOpml,
  usePatchFeedEntry,
  useSubscribeFeed,
  useUpdateFeed,
} from "#/api/feeds";
import type { components } from "#/api/schema";

const { NativeRequest, fetchMock } = vi.hoisted(() => {
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
  return { NativeRequest, fetchMock };
});

type FeedEntry = components["schemas"]["FeedEntryDto"];
type FeedEntryPage = components["schemas"]["FeedEntryPageResponse"];
type FeedList = components["schemas"]["FeedListResponse"];
type EntryPages = InfiniteData<FeedEntryPage, string | undefined>;

const feedsPath = "/api/vault/feeds";
const entriesPath = "/api/vault/feeds/entries";
const feedsKey = ["get", feedsPath] as const;
const requestOrigin = "https://ui.test";

function entriesKey(filters: EntryFilters) {
  return ["get", entriesPath, { params: { query: filters } }] as const;
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function freshClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 101,
    feed_id: 7,
    guid: "entry-101",
    title: "Cache semantics",
    url: "https://example.test/posts/cache-semantics",
    author: "Kit",
    content_html: "<p>Cache semantics</p>",
    published_at: "2026-08-09T08:00:00Z",
    fetched_at: "2026-08-09T08:01:00Z",
    read: false,
    bookmarked: true,
    tags: ["research", "rust"],
    ...overrides,
  };
}

function makePages(
  entries: FeedEntry[],
  pageParams: Array<string | undefined> = [undefined],
): EntryPages {
  return {
    pages: [{ entries, next_cursor: "next-page" }],
    pageParams,
  };
}

function makeFeedList(manifestRevision: string): FeedList {
  return {
    diagnostics: [],
    groups: [
      {
        name: "Engineering",
        feeds: [
          {
            id: 7,
            title: "Example",
            title_override: null,
            url: "https://example.test/feed.xml",
            fetch_url: "https://example.test/feed.xml",
            site_url: "https://example.test",
            group: "Engineering",
            tags: ["rust"],
            last_fetch_at: null,
            next_fetch_at: "2026-08-09T09:00:00Z",
            error_count: 0,
            last_error: null,
          },
        ],
      },
    ],
    manifest_revision: manifestRevision,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestedUrl(
  fetchMock: MockInstance<typeof globalThis.fetch>,
  call = 0,
) {
  const input = fetchMock.mock.calls[call]?.[0];
  return new URL(
    input instanceof NativeRequest ? input.url : String(input),
    requestOrigin,
  );
}

async function requestBody(
  fetchMock: MockInstance<typeof globalThis.fetch>,
  call = 0,
) {
  const [input, init] = fetchMock.mock.calls[call] ?? [];
  if (input instanceof NativeRequest) {
    return input.clone().json();
  }
  return JSON.parse(String(init?.body));
}

describe("updateCachedEntryPages", () => {
  it("removes a read entry from unread caches but updates it in all-entry caches", () => {
    const entry = makeEntry({ read: false });
    const before = makePages([entry], ["cursor-before"]);

    const unread = updateCachedEntryPages(
      before,
      { id: entry.id, read: true },
      { view: "unread" },
    );
    const all = updateCachedEntryPages(
      before,
      { id: entry.id, read: true },
      { view: "all" },
    );

    expect(unread.pages[0].entries).toEqual([]);
    expect(all.pages[0].entries[0]).toEqual({ ...entry, read: true });
    expect(all.pageParams).toEqual(["cursor-before"]);
  });

  it("removes an unbookmarked entry from saved caches", () => {
    const entry = makeEntry({ bookmarked: true });

    const result = updateCachedEntryPages(
      makePages([entry]),
      { id: entry.id, bookmarked: false },
      { view: "saved" },
    );

    expect(result.pages[0].entries).toEqual([]);
  });

  it("removes a present entry when its replacement tags no longer match the tag cache", () => {
    const entry = makeEntry({ tags: ["research", "rust"] });

    const result = updateCachedEntryPages(
      makePages([entry]),
      { id: entry.id, tags: ["rust"] },
      { view: "all", tag: "research" },
    );

    expect(result.pages[0].entries).toEqual([]);
  });

  it("leaves a cache exactly unchanged when the affected entry is absent", () => {
    const before = makePages([makeEntry({ id: 202 })], ["page-0"]);

    const result = updateCachedEntryPages(
      before,
      { id: 101, tags: ["newly-matching"] },
      { view: "all", tag: "newly-matching" },
    );

    expect(result).toBe(before);
    expect(result).toEqual(before);
  });

  it.each([
    ["feed", { view: "unread" as const, feed: 7 }],
    ["group", { view: "unread" as const, group: "Engineering" }],
  ])("retains a present entry in a matching %s cache", (_label, filters) => {
    const entry = makeEntry({ read: false });

    const result = updateCachedEntryPages(
      makePages([entry]),
      { id: entry.id, bookmarked: false },
      filters,
    );

    expect(result.pages[0].entries).toEqual([{ ...entry, bookmarked: false }]);
  });

  it("preserves every pageParam while patching entries across pages", () => {
    const entry = makeEntry();
    const second = makeEntry({ id: 202, guid: "entry-202" });
    const before: EntryPages = {
      pages: [
        { entries: [second], next_cursor: "cursor-1" },
        { entries: [entry], next_cursor: null },
      ],
      pageParams: [undefined, "cursor-1"],
    };

    const result = updateCachedEntryPages(
      before,
      { id: entry.id, read: true },
      { view: "all" },
    );

    expect(result.pageParams).toEqual([undefined, "cursor-1"]);
    expect(result.pages[0]).toBe(before.pages[0]);
    expect(result.pages[1].entries[0].read).toBe(true);
  });
});

describe("feedEntriesInfiniteOptions", () => {
  it("uses the OpenAPI query-key shape and omits cursor from the first request", async () => {
    const filters: EntryFilters = {
      view: "unread",
      feed: 7,
      group: "Engineering",
      tag: "rust",
      limit: 25,
    };
    const options = feedEntriesInfiniteOptions(filters);

    expect(options.queryKey).toEqual([
      "get",
      entriesPath,
      { params: { query: filters } },
    ]);

    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [], next_cursor: null }),
    );
    const client = freshClient();

    const result = await client.fetchInfiniteQuery(options);

    expect(result.pageParams).toEqual([undefined]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = requestedUrl(fetchMock);
    expect(requested.pathname).toBe(entriesPath);
    expect(requested.searchParams.get("view")).toBe("unread");
    expect(requested.searchParams.get("feed")).toBe("7");
    expect(requested.searchParams.get("group")).toBe("Engineering");
    expect(requested.searchParams.get("tag")).toBe("rust");
    expect(requested.searchParams.get("limit")).toBe("25");
    expect(requested.searchParams.has("cursor")).toBe(false);
  });

  it("excludes caller-supplied cursors from the public filter contract", () => {
    const filters: EntryFilters = {
      view: "all",
      // @ts-expect-error Pagination cursors are owned by the infinite query.
      cursor: "caller-controlled",
    };

    expect(filters).toHaveProperty("cursor", "caller-controlled");
  });

  it("strips an untrusted runtime cursor from the first key and request", async () => {
    const filters = {
      view: "unread",
      limit: 10,
      cursor: "caller-controlled",
    } as unknown as EntryFilters;
    const options = feedEntriesInfiniteOptions(filters);

    expect(options.queryKey).toEqual([
      "get",
      entriesPath,
      { params: { query: { view: "unread", limit: 10 } } },
    ]);
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [], next_cursor: null }),
    );

    await freshClient().fetchInfiniteQuery(options);

    const requested = requestedUrl(fetchMock);
    expect(requested.searchParams.get("view")).toBe("unread");
    expect(requested.searchParams.get("limit")).toBe("10");
    expect(requested.searchParams.has("cursor")).toBe(false);
  });

  it("uses next_cursor as the next OpenAPI cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ entries: [], next_cursor: "opaque-cursor" }),
      )
      .mockResolvedValueOnce(jsonResponse({ entries: [], next_cursor: null }));
    const client = freshClient();
    const observer = new InfiniteQueryObserver(
      client,
      feedEntriesInfiniteOptions({ view: "all", limit: 10 }),
    );
    const unsubscribe = observer.subscribe(() => undefined);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await observer.fetchNextPage();

    const firstUrl = requestedUrl(fetchMock);
    const secondUrl = requestedUrl(fetchMock, 1);
    expect(firstUrl.searchParams.has("cursor")).toBe(false);
    expect(secondUrl.searchParams.get("cursor")).toBe("opaque-cursor");
    expect(observer.getCurrentResult().data?.pageParams).toEqual([
      undefined,
      "opaque-cursor",
    ]);

    unsubscribe();
  });
});

describe("usePatchFeedEntry", () => {
  it("optimistically patches every cached filter key and restores each exact pair on failure", async () => {
    const entry = makeEntry({ read: false, bookmarked: true });
    const keys = {
      unread: entriesKey({ view: "unread" }),
      all: entriesKey({ view: "all" }),
      saved: entriesKey({ view: "saved" }),
      tag: entriesKey({ view: "all", tag: "research" }),
      absent: entriesKey({ view: "all", group: "Elsewhere" }),
    };
    const before = {
      unread: makePages([entry], ["unread-page"]),
      all: makePages([entry], ["all-page"]),
      saved: makePages([entry], ["saved-page"]),
      tag: makePages([entry], ["tag-page"]),
      absent: makePages([makeEntry({ id: 202 })], ["absent-page"]),
    };
    const client = freshClient();
    for (const name of Object.keys(keys) as Array<keyof typeof keys>) {
      client.setQueryData(keys[name], before[name]);
    }

    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    const mutation = result.current.mutateAsync({ id: entry.id, read: true });

    await waitFor(() => {
      const unread = client.getQueryData<EntryPages>(keys.unread);
      expect(unread?.pages[0].entries).toEqual([]);
    });
    expect(
      client.getQueryData<EntryPages>(keys.all)?.pages[0].entries[0].read,
    ).toBe(true);
    expect(
      client.getQueryData<EntryPages>(keys.saved)?.pages[0].entries[0].read,
    ).toBe(true);
    expect(
      client.getQueryData<EntryPages>(keys.tag)?.pages[0].entries[0].read,
    ).toBe(true);
    expect(client.getQueryData(keys.absent)).toBe(before.absent);

    response.resolve(
      jsonResponse({ error: "offline", hint: "try again" }, 500),
    );
    await expect(mutation).rejects.toEqual({
      error: "offline",
      hint: "try again",
    });

    for (const name of Object.keys(keys) as Array<keyof typeof keys>) {
      expect(client.getQueryData(keys[name])).toBe(before[name]);
    }
  });

  it("invalidates feed summaries and all entry filters so newly matching tag views refetch", async () => {
    const entry = makeEntry({ tags: ["rust"] });
    const client = freshClient();
    let feedSummaryFetches = 0;
    let newTagFetches = 0;
    const newTagKey = entriesKey({ view: "all", tag: "research" });

    const feedObserver = new QueryObserver(client, {
      queryKey: feedsKey,
      queryFn: async () => {
        feedSummaryFetches += 1;
        return makeFeedList(`revision-${feedSummaryFetches}`);
      },
    });
    const tagObserver = new QueryObserver(client, {
      queryKey: newTagKey,
      queryFn: async () => {
        newTagFetches += 1;
        return makePages(
          newTagFetches === 1 ? [] : [{ ...entry, tags: ["rust", "research"] }],
        );
      },
    });
    const unsubscribeFeed = feedObserver.subscribe(() => undefined);
    const unsubscribeTag = tagObserver.subscribe(() => undefined);
    await waitFor(() => {
      expect(feedSummaryFetches).toBe(1);
      expect(newTagFetches).toBe(1);
    });

    fetchMock.mockResolvedValue(
      jsonResponse({ ...entry, tags: ["rust", "research"] }),
    );
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    await result.current.mutateAsync({
      id: entry.id,
      tags: ["rust", "research"],
    });

    await waitFor(() => {
      expect(feedSummaryFetches).toBe(2);
      expect(newTagFetches).toBe(2);
    });
    expect(
      tagObserver
        .getCurrentResult()
        .data?.pages[0].entries.map((cachedEntry) => cachedEntry.id),
    ).toEqual([entry.id]);

    unsubscribeFeed();
    unsubscribeTag();
  });

  it.each([
    {
      name: "older mutation fails first",
      firstFailure: "older" as const,
      surviving: { read: false, bookmarked: false },
    },
    {
      name: "newer mutation fails first",
      firstFailure: "newer" as const,
      surviving: { read: true, bookmarked: true },
    },
  ])("rebases the surviving optimistic layer when the $name", async ({
    firstFailure,
    surviving,
  }) => {
    const entry = makeEntry({ read: false, bookmarked: true });
    const baseline = makePages([entry], ["baseline"]);
    const key = entriesKey({ view: "all" });
    const client = freshClient();
    client.setQueryData(key, baseline);
    const olderResponse = deferred<Response>();
    const newerResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise);
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    const olderMutation = result.current
      .mutateAsync({ id: entry.id, read: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newerMutation = result.current
      .mutateAsync({ id: entry.id, bookmarked: false })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
    ).toMatchObject({ read: true, bookmarked: false });

    const firstResponse =
      firstFailure === "older" ? olderResponse : newerResponse;
    const firstMutation =
      firstFailure === "older" ? olderMutation : newerMutation;
    firstResponse.resolve(
      jsonResponse({ error: `${firstFailure} failed` }, 500),
    );
    await expect(firstMutation).resolves.toEqual({
      error: `${firstFailure} failed`,
    });
    expect(
      client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
    ).toMatchObject(surviving);

    const lastResponse =
      firstFailure === "older" ? newerResponse : olderResponse;
    const lastMutation =
      firstFailure === "older" ? newerMutation : olderMutation;
    const lastFailure =
      firstFailure === "older" ? "newer failed" : "older failed";
    lastResponse.resolve(jsonResponse({ error: lastFailure }, 500));
    await expect(lastMutation).resolves.toEqual({ error: lastFailure });
    expect(client.getQueryData(key)).toBe(baseline);
  });

  it.each([
    "failure first",
    "success first",
  ] as const)("retains a successful newer patch when the older patch settles %s", async (settlementOrder) => {
    const entry = makeEntry({ read: false, bookmarked: true });
    const baseline = makePages([entry], ["baseline"]);
    const key = entriesKey({ view: "all" });
    const client = freshClient();
    client.setQueryData(key, baseline);
    const olderResponse = deferred<Response>();
    const newerResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise);
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    const olderMutation = result.current
      .mutateAsync({ id: entry.id, read: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newerMutation = result.current.mutateAsync({
      id: entry.id,
      bookmarked: false,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    if (settlementOrder === "failure first") {
      olderResponse.resolve(jsonResponse({ error: "older failed" }, 500));
      await expect(olderMutation).resolves.toEqual({
        error: "older failed",
      });
      expect(
        client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
      ).toMatchObject({ read: false, bookmarked: false });
      newerResponse.resolve(jsonResponse({ ...entry, bookmarked: false }));
      await newerMutation;
    } else {
      newerResponse.resolve(jsonResponse({ ...entry, bookmarked: false }));
      await newerMutation;
      olderResponse.resolve(jsonResponse({ error: "older failed" }, 500));
      await expect(olderMutation).resolves.toEqual({
        error: "older failed",
      });
    }

    expect(
      client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
    ).toMatchObject({ read: false, bookmarked: false });
    expect(client.getQueryData(key)).not.toBe(baseline);
  });

  it.each([
    "older response first",
    "newer response first",
  ] as const)("merges normalized successful fields without stale overwrite when the %s", async (responseOrder) => {
    const entry = makeEntry({
      read: false,
      bookmarked: true,
      tags: ["rust"],
    });
    const baseline = makePages([entry], ["baseline"]);
    const key = entriesKey({ view: "all" });
    const client = freshClient();
    client.setQueryData(key, baseline);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: key, exact: true })
        ?.getObserversCount(),
    ).toBe(0);
    const olderResponse = deferred<Response>();
    const newerResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise);
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    const olderMutation = result.current.mutateAsync({
      id: entry.id,
      read: true,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newerMutation = result.current.mutateAsync({
      id: entry.id,
      tags: [" rust ", "rust", "ai"],
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    if (responseOrder === "older response first") {
      olderResponse.resolve(
        jsonResponse({ ...entry, read: true, tags: ["rust"] }),
      );
      await olderMutation;
      expect(
        client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
      ).toMatchObject({
        read: true,
        tags: [" rust ", "rust", "ai"],
      });
      newerResponse.resolve(
        jsonResponse({
          ...entry,
          read: false,
          tags: ["rust", "ai"],
        }),
      );
      await newerMutation;
    } else {
      newerResponse.resolve(
        jsonResponse({
          ...entry,
          read: false,
          tags: ["rust", "ai"],
        }),
      );
      await newerMutation;
      expect(
        client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
      ).toMatchObject({ read: true, tags: ["rust", "ai"] });
      olderResponse.resolve(
        jsonResponse({ ...entry, read: true, tags: ["rust"] }),
      );
      await olderMutation;
    }

    expect(
      client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
    ).toMatchObject({
      read: true,
      bookmarked: true,
      tags: ["rust", "ai"],
    });
    expect(
      client
        .getQueryCache()
        .find({ queryKey: key, exact: true })
        ?.getObserversCount(),
    ).toBe(0);
  });

  it("recreates a removed inactive query and rebases its captured mutation layers", async () => {
    const entry = makeEntry({ read: false, bookmarked: true });
    const baseline = makePages([entry], ["captured-page"]);
    const key = entriesKey({ view: "all" });
    const client = freshClient();
    client.setQueryData(key, baseline);
    const originalQuery = client
      .getQueryCache()
      .find({ queryKey: key, exact: true });
    expect(originalQuery).toBeDefined();
    expect(originalQuery?.getObserversCount()).toBe(0);
    const olderResponse = deferred<Response>();
    const newerResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise);
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    const olderMutation = result.current
      .mutateAsync({ id: entry.id, read: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newerMutation = result.current
      .mutateAsync({ id: entry.id, bookmarked: false })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    client.removeQueries({ queryKey: key, exact: true });
    expect(
      client.getQueryCache().find({ queryKey: key, exact: true }),
    ).toBeUndefined();

    olderResponse.resolve(
      jsonResponse({ error: "older failed after removal" }, 500),
    );
    await expect(olderMutation).resolves.toEqual({
      error: "older failed after removal",
    });
    const recreatedQuery = client
      .getQueryCache()
      .find({ queryKey: key, exact: true });
    expect(recreatedQuery).toBeDefined();
    expect(recreatedQuery).not.toBe(originalQuery);
    expect(recreatedQuery?.queryKey).toEqual(key);
    expect(
      client.getQueryData<EntryPages>(key)?.pages[0].entries[0],
    ).toMatchObject({ read: false, bookmarked: false });

    newerResponse.resolve(
      jsonResponse({ error: "newer failed after removal" }, 500),
    );
    await expect(newerMutation).resolves.toEqual({
      error: "newer failed after removal",
    });
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(
      recreatedQuery,
    );
    expect(client.getQueryData(key)).toBe(baseline);
  });

  it("adopts an independently recreated query and restores the exact captured baseline", async () => {
    const entry = makeEntry({ read: false });
    const baseline = makePages([entry], ["captured-page"]);
    const key = entriesKey({ view: "all" });
    const client = freshClient();
    client.setQueryData(key, baseline);
    const originalQuery = client
      .getQueryCache()
      .find({ queryKey: key, exact: true });
    expect(originalQuery).toBeDefined();
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const { result } = renderHook(() => usePatchFeedEntry(), {
      wrapper: wrapper(client),
    });

    const mutation = result.current
      .mutateAsync({ id: entry.id, read: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    client.removeQueries({ queryKey: key, exact: true });

    const independentClone: EntryPages = {
      pages: baseline.pages.map((page) => ({
        ...page,
        entries: page.entries.map((cachedEntry) => ({ ...cachedEntry })),
      })),
      pageParams: [...baseline.pageParams],
    };
    client.setQueryData(key, independentClone);
    const replacementQuery = client
      .getQueryCache()
      .find({ queryKey: key, exact: true });
    expect(replacementQuery).toBeDefined();
    expect(replacementQuery).not.toBe(originalQuery);
    expect(replacementQuery?.queryKey).toEqual(key);
    expect(client.getQueryData(key)).toBe(independentClone);
    expect(independentClone).toEqual(baseline);
    expect(independentClone).not.toBe(baseline);

    response.resolve(
      jsonResponse({ error: "failed after independent recreation" }, 500),
    );
    await expect(mutation).resolves.toEqual({
      error: "failed after independent recreation",
    });

    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(
      replacementQuery,
    );
    expect(client.getQueryData(key)).toBe(baseline);
  });
});

describe("feed membership mutations", () => {
  const cases = [
    {
      name: "subscribe",
      useMutation: useSubscribeFeed,
      variables: {
        url: "https://new.example/feed.xml",
        group: "Reading",
        tags: ["daily"],
        title: "New feed",
      },
      expectedBody: {
        expected_revision: "revision-current",
        url: "https://new.example/feed.xml",
        group: "Reading",
        tags: ["daily"],
        title: "New feed",
      },
      method: "POST",
      path: feedsPath,
      response: {
        feed: makeFeedList("revision-current").groups[0].feeds[0],
        manifest_revision: "revision-next",
      },
    },
    {
      name: "update",
      useMutation: useUpdateFeed,
      variables: { id: 7, title: "Renamed", group: "Reading" },
      expectedBody: {
        expected_revision: "revision-current",
        title: "Renamed",
        group: "Reading",
      },
      method: "PATCH",
      path: `${feedsPath}/7`,
      response: {
        feed: makeFeedList("revision-current").groups[0].feeds[0],
        manifest_revision: "revision-next",
      },
    },
    {
      name: "delete",
      useMutation: useDeleteFeed,
      variables: { id: 7 },
      expectedBody: { expected_revision: "revision-current" },
      response: { manifest_revision: "revision-next" },
      method: "DELETE",
      path: `${feedsPath}/7`,
    },
    {
      name: "OPML import",
      useMutation: useImportOpml,
      variables: { opml: '<opml version="2.0"><body /></opml>' },
      expectedBody: {
        expected_revision: "revision-current",
        opml: '<opml version="2.0"><body /></opml>',
      },
      response: { added: 0, manifest_revision: "revision-next" },
      method: "POST",
      path: `${feedsPath}/import`,
    },
  ] as const;

  it.each(cases)("uses the latest cached manifest_revision for $name", async ({
    useMutation,
    variables,
    expectedBody,
    response,
    method,
    path,
  }) => {
    const client = freshClient();
    client.setQueryData(feedsKey, makeFeedList("revision-stale"));
    fetchMock.mockResolvedValue(jsonResponse(response));
    const { result } = renderHook(() => useMutation(), {
      wrapper: wrapper(client),
    });

    client.setQueryData(feedsKey, makeFeedList("revision-current"));
    const mutateAsync = result.current.mutateAsync as (
      input: typeof variables,
    ) => Promise<unknown>;
    await mutateAsync(variables);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await requestBody(fetchMock)).toEqual(expectedBody);
    expect(requestedUrl(fetchMock).pathname).toBe(path);
    const [requestInput, requestInit] = fetchMock.mock.calls[0];
    const actualMethod =
      requestInput instanceof NativeRequest
        ? requestInput.method
        : (requestInit?.method ?? "GET");
    expect(actualMethod).toBe(method);
  });

  it("does not let a late membership response downgrade a newer manifest revision", async () => {
    const client = freshClient();
    client.setQueryData(feedsKey, makeFeedList("revision-0"));
    const olderResponse = deferred<Response>();
    const newerResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise);
    const { result } = renderHook(() => useSubscribeFeed(), {
      wrapper: wrapper(client),
    });

    const olderMutation = result.current.mutateAsync({
      url: "https://older.example/feed.xml",
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newerMutation = result.current.mutateAsync({
      url: "https://newer.example/feed.xml",
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await requestBody(fetchMock)).toMatchObject({
      expected_revision: "revision-0",
    });
    expect(await requestBody(fetchMock, 1)).toMatchObject({
      expected_revision: "revision-0",
    });

    newerResponse.resolve(
      jsonResponse({
        feed: makeFeedList("revision-0").groups[0].feeds[0],
        manifest_revision: "revision-2",
      }),
    );
    await newerMutation;
    expect(client.getQueryData<FeedList>(feedsKey)?.manifest_revision).toBe(
      "revision-2",
    );

    olderResponse.resolve(
      jsonResponse({
        feed: makeFeedList("revision-0").groups[0].feeds[0],
        manifest_revision: "revision-1",
      }),
    );
    await olderMutation;
    expect(client.getQueryData<FeedList>(feedsKey)?.manifest_revision).toBe(
      "revision-2",
    );
  });

  it("awaits feed and entry refetches after 409 before a retry reads the revision", async () => {
    const conflict = {
      error: "manifest revision conflict",
      hint: "refresh feed subscriptions and retry",
      detail: {
        expected_revision: "revision-0",
        current_revision: "revision-1",
      },
    };
    const client = freshClient();
    const entryKey = entriesKey({ view: "unread" });
    client.setQueryData(feedsKey, makeFeedList("revision-0"));
    client.setQueryData(entryKey, makePages([]));
    const feedRefetch = deferred<FeedList>();
    const entryRefetch = deferred<EntryPages>();
    let feedRefetches = 0;
    let entryRefetches = 0;
    const feedObserver = new QueryObserver(client, {
      queryKey: feedsKey,
      queryFn: () => {
        feedRefetches += 1;
        return feedRefetch.promise;
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const entryObserver = new QueryObserver(client, {
      queryKey: entryKey,
      queryFn: () => {
        entryRefetches += 1;
        return entryRefetch.promise;
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribeFeed = feedObserver.subscribe(() => undefined);
    const unsubscribeEntry = entryObserver.subscribe(() => undefined);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(conflict, 409))
      .mockResolvedValueOnce(
        jsonResponse({
          feed: makeFeedList("revision-1").groups[0].feeds[0],
          manifest_revision: "revision-2",
        }),
      );
    const { result } = renderHook(() => useSubscribeFeed(), {
      wrapper: wrapper(client),
    });

    let settled = false;
    let firstError: unknown;
    const firstMutation = result.current
      .mutateAsync({ url: "https://retry.example/feed.xml" })
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          firstError = error;
          settled = true;
        },
      );
    await waitFor(() => {
      expect(feedRefetches).toBe(1);
      expect(entryRefetches).toBe(1);
    });
    expect(settled).toBe(false);

    feedRefetch.resolve(makeFeedList("revision-1"));
    await waitFor(() =>
      expect(client.getQueryData<FeedList>(feedsKey)?.manifest_revision).toBe(
        "revision-1",
      ),
    );
    expect(settled).toBe(false);

    entryRefetch.resolve(makePages([]));
    await firstMutation;
    expect(firstError).toEqual(conflict);
    unsubscribeFeed();
    unsubscribeEntry();

    await result.current.mutateAsync({
      url: "https://retry.example/feed.xml",
    });

    expect(await requestBody(fetchMock)).toMatchObject({
      expected_revision: "revision-0",
    });
    expect(await requestBody(fetchMock, 1)).toMatchObject({
      expected_revision: "revision-1",
    });
  });

  it("surfaces a structured 409 and refetches the manifest revision", async () => {
    const conflict = {
      error: "manifest revision conflict",
      hint: "refresh feed subscriptions and retry",
      detail: {
        expected_revision: "revision-stale",
        current_revision: "revision-current",
      },
    };
    const client = freshClient();
    client.setQueryData(feedsKey, makeFeedList("revision-stale"));
    let manifestRefetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: feedsKey,
      queryFn: async () => {
        manifestRefetches += 1;
        return makeFeedList("revision-current");
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    fetchMock.mockResolvedValue(jsonResponse(conflict, 409));
    const { result } = renderHook(() => useSubscribeFeed(), {
      wrapper: wrapper(client),
    });

    await expect(
      result.current.mutateAsync({ url: "https://new.example/feed.xml" }),
    ).rejects.toEqual(conflict);

    expect(await requestBody(fetchMock)).toEqual({
      expected_revision: "revision-stale",
      url: "https://new.example/feed.xml",
    });
    await waitFor(() => expect(manifestRefetches).toBe(1));
    expect(observer.getCurrentResult().data?.manifest_revision).toBe(
      "revision-current",
    );

    unsubscribe();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});
