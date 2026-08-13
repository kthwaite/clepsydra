import type { PageSummary } from "#/api/types";

export function normalizeWikilinkIdentity(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\.md$/u, "");
}

export function pageHasExactWikilinkIdentity(
  page: PageSummary,
  query: string,
): boolean {
  const expected = normalizeWikilinkIdentity(query);
  if (!expected) return false;

  return [page.title, page.canonical_name, page.path, ...page.aliases]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeWikilinkIdentity(value) === expected);
}
