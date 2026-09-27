import { fetchClient } from "#/api/client";
import type { components } from "#/api/schema";
import { normalizeWikilinkIdentity } from "#/editor/wikilinkIdentity";

type SearchResultEntry = components["schemas"]["SearchResultEntry"];

/** Which identities of a search entry a wikilink may name. */
export type WikilinkMatch = "title" | "title-stem-or-path";

function fileStem(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return basename.replace(/\.md$/iu, "");
}

function identities(entry: SearchResultEntry, match: WikilinkMatch): string[] {
  const title = entry.title ?? null;
  if (match === "title") return title === null ? [] : [title];
  // Path first: it is the most specific name a link can carry.
  return [entry.path, ...(title === null ? [] : [title]), fileStem(entry.path)];
}

/**
 * Search the vault index for the page a wikilink names. `name` is compared
 * with `normalizeWikilinkIdentity`, which also drops a trailing `.md`, so a
 * path matches with or without its extension. Throws when the search fails.
 */
export async function searchWikilinkTarget(
  name: string,
  match: WikilinkMatch,
): Promise<string | null> {
  const { data, error } = await fetchClient.GET("/api/vault/index/search", {
    params: { query: { q: name } },
  });
  if (error) throw error;
  const key = normalizeWikilinkIdentity(name);
  const entries = data ?? [];
  // Rank by identity kind across all entries, so an exact path beats a
  // title match on an earlier result.
  const rank = (entry: SearchResultEntry) =>
    identities(entry, match).findIndex(
      (identity) => normalizeWikilinkIdentity(identity) === key,
    );
  let best: { path: string; rank: number } | null = null;
  for (const entry of entries) {
    const entryRank = rank(entry);
    if (entryRank !== -1 && (best === null || entryRank < best.rank)) {
      best = { path: entry.path, rank: entryRank };
    }
  }
  return best?.path ?? null;
}
