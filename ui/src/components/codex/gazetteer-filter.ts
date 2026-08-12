// Pure filtering + sorting for the GAZETTEER table. No React, no I/O — testable.

export type GazetteerSort = "ts" | "id" | "title" | "words";

export function appendUniqueTag(
  selectedTags: string[],
  tag: string,
): string[] {
  return selectedTags.includes(tag) ? selectedTags : [...selectedTags, tag];
}

export interface GazetteerRow {
  path: string;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  updated_at?: string | null;
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

  const sorted = [...out];
  sorted.sort((a, b) => {
    if (sort === "ts") {
      return (
        (b.updated_at ? Date.parse(b.updated_at) : 0) -
        (a.updated_at ? Date.parse(a.updated_at) : 0)
      );
    }
    if (sort === "words") {
      return (b.word_count ?? 0) - (a.word_count ?? 0);
    }
    if (sort === "title") {
      return (a.title ?? a.path).localeCompare(b.title ?? b.path);
    }
    return a.path.localeCompare(b.path);
  });
  return sorted;
}
