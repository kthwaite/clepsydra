import type { ReactNode } from "react";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Splits `text` on every case-insensitive occurrence of any non-empty needle
 * and wraps the matches in an `accent-tint` mark (the Folio "Linked from"
 * snippet, spec §5.6). Text only — never parsed as HTML.
 */
export function highlightMatch(text: string, needles: string[]): ReactNode {
  const terms = [...new Set(needles.map((n) => n.trim()).filter(Boolean))]
    // Longest first, so "Heron" wins over its prefix "Hero".
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (terms.length === 0) return text;
  // Whole words only: no letter or digit may touch either end of a match.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${terms.join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    // split() with one capture group puts matches at odd indices.
    index % 2 === 1 ? (
      <mark
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
        key={index}
        className="rounded-[3px] bg-accent-tint px-0.5 text-ink-2"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** Reads `[[target]]` / `[[target|alias]]` as display text (the alias, else
 *  the target without its `#heading` / `^block` anchor), so a backlink
 *  snippet reads as prose. */
export function plainWikiText(text: string): string {
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
    (alias ?? target.replace(/[#^].*$/, "")).trim(),
  );
}
