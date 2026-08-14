/**
 * Shared `[key:: value]` inline-property syntax.
 *
 * One source of truth for both directions: the loader
 * (`convert/mdast-to-slate.ts`) scans saved markdown for these pairs and lifts
 * them onto the block's `properties` record, and the autoformat rule
 * (`plugins/autoformat/inlineTransforms.ts`) recognizes the same shape as it is
 * typed. `convert/slate-to-mdast.ts` re-emits the record in this exact form.
 *
 * Known limitation: URL values (e.g. `[url:: https://example.com]`) fail to
 * parse on load because remark-gfm auto-links the URL before the scan runs,
 * fragmenting the `[key:: value]` text across multiple AST nodes (text + link
 * + text). Fixing this would require either disabling auto-linking globally
 * (breaking other features) or pre-processing raw markdown (fragile). Accepted
 * as a v2 concern — URL values in inline properties are uncommon in practice.
 */
const INLINE_PROPERTY_SOURCE = /\[([A-Za-z_][\w-]*)::[ \t]+([^\]]+)\]/.source;

/** Keys the task affordances (chips, popover) surface on task list items. */
export const TASK_PROPERTY_KEYS = ["due", "scheduled", "priority"] as const;

export type TaskPropertyKey = (typeof TASK_PROPERTY_KEYS)[number];

export type InlinePropertyMatch = {
  /** Offset of the opening `[` within the scanned text. */
  index: number;
  key: string;
  value: string;
};

/**
 * A fresh global regex for scanning a string for every `[key:: value]` pair.
 * Returned per call so callers never share `lastIndex` state.
 */
export function inlinePropertyScanner(): RegExp {
  return new RegExp(INLINE_PROPERTY_SOURCE, "g");
}

const TRAILING_INLINE_PROPERTY = new RegExp(`${INLINE_PROPERTY_SOURCE}$`);

/**
 * Match a single `[key:: value]` pair anchored at the end of `text`.
 * Used by the typed-syntax rule, where the pair is complete the moment the
 * closing `]` is typed.
 */
export function matchTrailingInlineProperty(
  text: string,
): InlinePropertyMatch | null {
  const match = TRAILING_INLINE_PROPERTY.exec(text);
  if (!match) return null;
  return { index: match.index, key: match[1], value: match[2] };
}
