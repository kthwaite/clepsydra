import { refractor } from "refractor";

/** Common languages surfaced first in the picker, in priority order. */
export const COMMON_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "rust",
  "go",
  "bash",
  "json",
  "html",
  "css",
  "sql",
  "yaml",
  "markdown",
] as const;

/** Uppercase display label for a language id (matches the code-block header). */
export function displayLabel(id: string): string {
  return id.toUpperCase();
}

/**
 * All refractor-registered grammars, with the registered subset of
 * COMMON_LANGUAGES pinned to the front (in COMMON order) and the rest
 * following alphabetically. Aliases are collapsed to a single canonical
 * name per grammar, so each grammar appears at most once.
 */
export function listLanguageIds(): string[] {
  const registered = refractor.listLanguages();
  const registeredSet = new Set(registered);
  const common = COMMON_LANGUAGES.filter((id) => registeredSet.has(id));

  // refractor.listLanguages() returns aliases (e.g. "js", "ts") as flat peers
  // of their canonical grammar ("javascript", "typescript"). Collapse them so
  // the picker lists each grammar once. Aliases share grammar-object identity
  // with their canonical name.
  const grammars = refractor.languages as Record<string, object>;
  const claimed = new Set<object>(common.map((id) => grammars[id]));

  const chosen = new Map<object, string>();
  for (const id of registered) {
    const grammar = grammars[id];
    if (claimed.has(grammar)) continue; // already represented by a common entry
    const current = chosen.get(grammar);
    // Prefer the longest name as the canonical label (e.g. "javascript" > "js").
    if (current === undefined || id.length > current.length) {
      chosen.set(grammar, id);
    }
  }

  const rest = [...chosen.values()].sort();
  return [...common, ...rest];
}

/**
 * Case-insensitive substring filter over `listLanguageIds()`.
 * An empty query returns the full curated-first ordering.
 */
export function filterLanguages(query: string): string[] {
  const all = listLanguageIds();
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((id) => id.toLowerCase().includes(q));
}
