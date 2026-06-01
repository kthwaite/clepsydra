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
 * All refractor-registered language ids, with the registered subset of
 * COMMON_LANGUAGES pinned to the front (in COMMON order) and the rest
 * following alphabetically. Deduplicated.
 */
export function listLanguageIds(): string[] {
  const registered = refractor.listLanguages();
  const registeredSet = new Set(registered);
  const common = COMMON_LANGUAGES.filter((id) => registeredSet.has(id));
  const commonSet = new Set<string>(common);
  const rest = registered.filter((id) => !commonSet.has(id)).sort();
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
