/** How an embedded Base view presents itself. Presentation is deliberately
 * separate from `BaseEmbedConfig`: it never reaches the query, so resizing an
 * embed or switching its chrome cannot refetch a single row. */

export type BaseEmbedDisplay = "compact" | "full";

export interface BaseEmbedPresentation {
  /** Absent means compact — the default for an embed inside a document. */
  display?: BaseEmbedDisplay;
  /** Absent means the embed fills the column it sits in. */
  width?: number;
}

export const EMBED_WIDTH_MIN = 480;
export const EMBED_WIDTH_MAX = 1600;
/** One arrow-key press on the embed's splitter. */
export const EMBED_WIDTH_STEP = 40;

export function isBaseEmbedDisplay(value: unknown): value is BaseEmbedDisplay {
  return value === "compact" || value === "full";
}

export function clampEmbedWidth(width: number): number {
  return Math.min(
    EMBED_WIDTH_MAX,
    Math.max(EMBED_WIDTH_MIN, Math.round(width)),
  );
}

/** Compact unless the author opted out. */
export function embedIsCompact(presentation: BaseEmbedPresentation): boolean {
  return presentation.display !== "full";
}
