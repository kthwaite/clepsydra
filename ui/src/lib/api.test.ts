import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  type EntriesResponse,
  type Entry,
  type EntryFilters,
  type EntryPatch,
  optimisticallyUpdateEntryCaches,
  reconcileEntryPatchQueries,
  restoreEntryCaches,
  updateEntryCache,
} from "./api";

type EntriesCache = InfiniteData<EntriesResponse, string | null>;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 1,
    feed_id: 10,
    feed_title: "Example feed",
    group: "Tech",
    url: "https://example.com/one",
    title: "One",
    author: null,
    content_html: null,
    published_at: "2026-08-08T12:00:00Z",
    sort_ts: "2026-08-08T12:00:00Z",
    read: false,
    bookmarked: true,
    tags: ["rust"],
    feed_tags: [],
    ...overrides,
  };
}

function cache(): EntriesCache {
  return {
    pages: [
      {
        entries: [entry(), entry({ id: 2, title: "Two" })],
        next_cursor: "page-2",
      },
      {
        entries: [entry({ id: 3, title: "Three" })],
        next_cursor: null,
      },
    ],
    pageParams: [null, "page-2"],
  };
}

interface MembershipCase {
  name: string;
  filters: EntryFilters;
  patch: EntryPatch;
  retained: boolean;
}

const membershipCases: MembershipCase[] = [
  {
    name: "removes an entry marked read from the unread view",
    filters: { view: "unread" },
    patch: { read: true },
    retained: false,
  },
  {
    name: "retains an entry marked unread in the unread view",
    filters: { view: "unread" },
    patch: { read: false },
    retained: true,
  },
  {
    name: "removes an entry unbookmarked from the saved view",
    filters: { view: "saved" },
    patch: { bookmarked: false },
    retained: false,
  },
  {
    name: "retains an entry bookmarked in the saved view",
    filters: { view: "saved" },
    patch: { bookmarked: true },
    retained: true,
  },
  {
    name: "removes an entry when its selected tag is removed",
    filters: { view: "all", tag: "rust" },
    patch: { tags: [] },
    retained: false,
  },
  {
    name: "retains an entry when it keeps the selected tag",
    filters: { view: "all", tag: "rust" },
    patch: { tags: ["rust"] },
    retained: true,
  },
  {
    name: "retains a patched entry in the all view",
    filters: { view: "all" },
    patch: { read: true, bookmarked: false, tags: [] },
    retained: true,
  },
];

describe("updateEntryCache", () => {
  it.each(membershipCases)("$name", ({ filters, patch, retained }) => {
    const original = cache();
    const unaffectedEntry = original.pages[0].entries[1];
    const unaffectedPage = original.pages[1];
    const result = updateEntryCache(original, filters, 1, patch);
    const patched = result.pages[0].entries.find(({ id }) => id === 1);

    expect(patched !== undefined).toBe(retained);
    if (patched) {
      expect(patched).toMatchObject(patch);
    } else {
      expect(result.pages.map((page) => page.entries.map(({ id }) => id))).toEqual([
        [2],
        [3],
      ]);
      expect(result.pages.map(({ next_cursor }) => next_cursor)).toEqual([
        "page-2",
        null,
      ]);
      expect(result.pageParams).toBe(original.pageParams);
      expect(result.pages[0].entries[0]).toBe(unaffectedEntry);
      expect(result.pages[1]).toBe(unaffectedPage);
    }
  });

  it.each([
    ["read", { read: true }],
    ["bookmark", { bookmarked: false }],
    ["entry-tag", { tags: ["typescript"] }],
  ] satisfies Array<[string, EntryPatch]>)(
    "retains a feed-derived tag match after a %s patch",
    (_kind, patch) => {
      const original: EntriesCache = {
        pages: [
          {
            entries: [entry({ tags: [], feed_tags: ["rust"] })],
            next_cursor: null,
          },
        ],
        pageParams: [null],
      };

      const result = updateEntryCache(
        original,
        { view: "all", tag: "rust" },
        1,
        patch,
      );

      expect(result.pages[0].entries).toHaveLength(1);
      expect(result.pages[0].entries[0]).toMatchObject({
        ...patch,
        feed_tags: ["rust"],
      });
    },
  );

  it("removes an entry when its last entry-owned match is removed and feed tags do not match", () => {
    const original: EntriesCache = {
      pages: [
        {
          entries: [entry({ tags: ["rust"], feed_tags: ["typescript"] })],
          next_cursor: null,
        },
      ],
      pageParams: [null],
    };

    const result = updateEntryCache(
      original,
      { view: "all", tag: "rust" },
      1,
      { tags: [] },
    );

    expect(result.pages[0].entries).toEqual([]);
  });

  it("preserves page order, cursors, and unaffected entries and pages", () => {
    const original = cache();
    const unaffectedEntry = original.pages[0].entries[1];
    const unaffectedPage = original.pages[1];

    const result = updateEntryCache(original, { view: "all" }, 1, {
      read: true,
    });

    expect(result.pages.map((page) => page.entries.map(({ id }) => id))).toEqual([
      [1, 2],
      [3],
    ]);
    expect(result.pages.map(({ next_cursor }) => next_cursor)).toEqual([
      "page-2",
      null,
    ]);
    expect(result.pageParams).toBe(original.pageParams);
    expect(result.pages[0].entries[1]).toBe(unaffectedEntry);
    expect(result.pages[1]).toBe(unaffectedPage);
  });
});

describe("entry cache snapshots", () => {
  const unreadKey = ["entries", { view: "unread" }] as const;
  const savedKey = ["entries", { view: "saved" }] as const;
  const tagKey = ["entries", { view: "all", tag: "rust" }] as const;
  const allKey = ["entries", { view: "all" }] as const;
  const undefinedKey = ["entries", { view: "all", feed: 99 }] as const;

  function populatedClient() {
    const queryClient = new QueryClient();
    const originals = {
      unread: cache(),
      saved: cache(),
      tag: cache(),
      all: cache(),
    };
    queryClient.setQueryData(unreadKey, originals.unread);
    queryClient.setQueryData(savedKey, originals.saved);
    queryClient.setQueryData(tagKey, originals.tag);
    queryClient.setQueryData(allKey, originals.all);
    const undefinedQuery = queryClient.getQueryCache().build(queryClient, {
      queryKey: undefinedKey,
      queryFn: async () => cache(),
    });

    return { queryClient, originals, undefinedQuery };
  }

  it("snapshots every entries cache and applies each query key's filters", () => {
    const { queryClient, originals, undefinedQuery } = populatedClient();

    const snapshots = optimisticallyUpdateEntryCaches(queryClient, 1, {
      read: true,
      bookmarked: false,
      tags: [],
    });
    const snapshotByKey = new Map(
      snapshots.map(([queryKey, data]) => [JSON.stringify(queryKey), data]),
    );

    expect(snapshotByKey.get(JSON.stringify(unreadKey))).toBe(originals.unread);
    expect(snapshotByKey.get(JSON.stringify(savedKey))).toBe(originals.saved);
    expect(snapshotByKey.get(JSON.stringify(tagKey))).toBe(originals.tag);
    expect(snapshotByKey.get(JSON.stringify(allKey))).toBe(originals.all);
    expect(snapshotByKey.has(JSON.stringify(undefinedKey))).toBe(true);
    expect(snapshotByKey.get(JSON.stringify(undefinedKey))).toBeUndefined();
    expect(queryClient.getQueryData<EntriesCache>(unreadKey)?.pages[0].entries).toHaveLength(
      1,
    );
    expect(queryClient.getQueryData<EntriesCache>(savedKey)?.pages[0].entries).toHaveLength(
      1,
    );
    expect(queryClient.getQueryData<EntriesCache>(tagKey)?.pages[0].entries).toHaveLength(
      1,
    );
    expect(
      queryClient.getQueryData<EntriesCache>(allKey)?.pages[0].entries[0],
    ).toMatchObject({
      id: 1,
      read: true,
      bookmarked: false,
      tags: [],
    });
    expect(queryClient.getQueryData(undefinedKey)).toBeUndefined();
    expect(
      queryClient.getQueryCache().find({ queryKey: undefinedKey, exact: true }),
    ).toBe(undefinedQuery);
  });

  it("restores every cache snapshot and removes an originally undefined cache", () => {
    const { queryClient, originals } = populatedClient();
    const snapshots = optimisticallyUpdateEntryCaches(queryClient, 1, {
      read: true,
      bookmarked: false,
      tags: [],
    });
    queryClient.setQueryData(undefinedKey, cache());

    restoreEntryCaches(queryClient, snapshots);

    expect(queryClient.getQueryData(unreadKey)).toStrictEqual(originals.unread);
    expect(queryClient.getQueryData(savedKey)).toStrictEqual(originals.saved);
    expect(queryClient.getQueryData(tagKey)).toStrictEqual(originals.tag);
    expect(queryClient.getQueryData(allKey)).toStrictEqual(originals.all);
    expect(queryClient.getQueryData(undefinedKey)).toBeUndefined();
    expect(
      queryClient.getQueryCache().find({ queryKey: undefinedKey, exact: true }),
    ).toBeUndefined();
  });

  it("invalidates entry and feed caches when a patch settles", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(unreadKey, cache());
    queryClient.setQueryData(["feeds"], { feeds: [], warnings: [] });

    await reconcileEntryPatchQueries(queryClient);

    expect(
      queryClient.getQueryCache().find({ queryKey: unreadKey, exact: true })?.state
        .isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryCache().find({ queryKey: ["feeds"], exact: true })?.state
        .isInvalidated,
    ).toBe(true);
  });
});
