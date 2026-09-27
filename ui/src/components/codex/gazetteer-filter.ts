// Pure filtering + sorting for the GAZETTEER table. No React, no I/O — testable.

import type { ContentIndexSort } from "#/api/types";

export type GazetteerSort = "ts" | "created" | "title" | "words";

const CONTENT_INDEX_SORT: Record<GazetteerSort, ContentIndexSort> = {
  ts: "updated",
  created: "created",
  title: "title",
  words: "words",
};

/** The server-side content-index order that matches a Gazetteer sort. */
export function toContentIndexSort(sort: GazetteerSort): ContentIndexSort {
  return CONTENT_INDEX_SORT[sort];
}

export function appendUniqueTag(selectedTags: string[], tag: string): string[] {
  return selectedTags.includes(tag) ? selectedTags : [...selectedTags, tag];
}

export interface GazetteerRow {
  path: string;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  updated_at?: string | null;
  created_at?: string | null;
  word_count?: number | null;
}

export interface GazetteerFilter {
  /** All selected tags must be present on a row (AND semantics). */
  tags: string[];
  /** Case-insensitive substring grep over title/path/description/tags. */
  query: string;
  sort: GazetteerSort;
}

export function filterAndSortRows<T extends GazetteerRow>(
  items: T[],
  { tags, query, sort }: GazetteerFilter,
): T[] {
  const q = query.trim().toLowerCase();

  let out = items;
  if (tags.length > 0) {
    out = out.filter((n) => {
      const rowTags = n.tags ?? [];
      return tags.every((t) => rowTags.includes(t));
    });
  }
  if (q) {
    out = out.filter((n) =>
      `${n.title ?? ""} ${n.path} ${n.description ?? ""} ${(n.tags ?? []).join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }

  const time = (iso: string | null | undefined) =>
    iso ? Date.parse(iso) || 0 : 0;
  const compare: Record<GazetteerSort, (a: T, b: T) => number> = {
    ts: (a, b) => time(b.updated_at) - time(a.updated_at),
    created: (a, b) => time(b.created_at) - time(a.created_at),
    words: (a, b) => (b.word_count ?? 0) - (a.word_count ?? 0),
    title: (a, b) => (a.title ?? a.path).localeCompare(b.title ?? b.path),
  };
  return [...out].sort(compare[sort]);
}
