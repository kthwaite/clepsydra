import type { Refractor } from "#/editor/refractor-lazy";

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

/**
 * Alias names that share a grammar with another language but should still
 * surface as their own picker row. zsh has no dedicated Prism grammar — it
 * reuses bash (registered as an alias in refractor-languages.ts) — but
 * operators expect to select "zsh" explicitly. Listed here so the alias-collapse
 * in `listLanguageIds` keeps them instead of folding them back into the host
 * grammar; pinned just after the common block.
 */
export const CURATED_ALIASES = ["zsh"] as const;

/** Uppercase display label for a language id (matches the code-block header). */
export function displayLabel(id: string): string {
  return id.toUpperCase();
}

/**
 * All refractor-registered grammars, with the registered subset of
 * COMMON_LANGUAGES pinned to the front (in COMMON order) and the rest
 * following alphabetically. Aliases are collapsed to a single canonical
 * name per grammar, so each grammar appears at most once — except the curated
 * aliases in CURATED_ALIASES (e.g. zsh), which get their own row. The plaintext
 * family (plain/plaintext/text/txt — all the same empty grammar) is
 * excluded; the picker's dedicated "Plain text" reset row covers it.
 *
 * The grammar bundle is injected (see refractor-lazy.ts). While it is still
 * loading (`refractor` null) the curated set stands in — every entry in it is
 * known to be registered once the bundle lands.
 */
export function listLanguageIds(refractor: Refractor | null): string[] {
  if (!refractor) return [...COMMON_LANGUAGES, ...CURATED_ALIASES];
  // Drop the plaintext family by grammar identity (plain/plaintext/text/txt
  // all map to the same empty grammar object), so they vanish in one filter.
  const grammars = refractor.languages as Record<string, object>;
  const plainGrammar = grammars.plaintext;
  const registered = refractor
    .listLanguages()
    .filter((id) => grammars[id] !== plainGrammar);
  const registeredSet = new Set(registered);
  const common = COMMON_LANGUAGES.filter((id) => registeredSet.has(id));
  // Curated aliases intentionally share a grammar with a common entry (e.g.
  // zsh→bash) but get their own row; pin them right after the common block.
  const curated = CURATED_ALIASES.filter((id) => registeredSet.has(id));
  const front = [...common, ...curated];

  // refractor.listLanguages() returns aliases (e.g. "js", "ts") as flat peers
  // of their canonical grammar ("javascript", "typescript"). Collapse them so
  // the picker lists each grammar once. Aliases share grammar-object identity
  // with their canonical name. Grammars already represented by a front entry
  // are claimed so they don't reappear (this also suppresses the host of a
  // curated alias, e.g. the remaining bash aliases sh/shell).
  const claimed = new Set<object>(front.map((id) => grammars[id]));

  const chosen = new Map<object, string>();
  for (const id of registered) {
    const grammar = grammars[id];
    if (claimed.has(grammar)) continue; // already represented by a front entry
    const current = chosen.get(grammar);
    // Prefer the longest name as the canonical label (e.g. "javascript" > "js").
    if (current === undefined || id.length > current.length) {
      chosen.set(grammar, id);
    }
  }

  const rest = [...chosen.values()].sort();
  return [...front, ...rest];
}

/**
 * Case-insensitive substring filter over `listLanguageIds()`.
 * An empty query returns the full curated-first ordering.
 */
export function filterLanguages(
  refractor: Refractor | null,
  query: string,
): string[] {
  const all = listLanguageIds(refractor);
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((id) => id.toLowerCase().includes(q));
}
