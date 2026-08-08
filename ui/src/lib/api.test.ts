import type { InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  type EntriesResponse,
  type Entry,
  type EntryFilters,
  type EntryPatch,
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
    const result = updateEntryCache(cache(), filters, 1, patch);
    const patched = result.pages[0].entries.find(({ id }) => id === 1);

    expect(patched !== undefined).toBe(retained);
    if (patched) {
      expect(patched).toMatchObject(patch);
    }
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
