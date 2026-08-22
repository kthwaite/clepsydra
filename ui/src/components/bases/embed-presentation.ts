import type { CSSProperties } from "react";

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
/** The width a splitter reports before anything has been measured. */
export const EMBED_WIDTH_FALLBACK = 900;

export function isBaseEmbedDisplay(value: unknown): value is BaseEmbedDisplay {
  return value === "compact" || value === "full";
}

export function clampEmbedWidth(width: number): number {
  return Math.min(
    EMBED_WIDTH_MAX,
    Math.max(EMBED_WIDTH_MIN, Math.round(width)),
  );
}

/** How an authored width renders.
 *
 * The width is the embed's own; the pane it sits in is the hard bound, so an
 * embed may exceed the reading column — that is the point of setting one —
 * but never the window. `100%` here is the column, so the margin re-centres
 * the embed and, when it is wider than the column, bleeds it symmetrically
 * into both margins. Without a pane publishing `--folio-pane-w` the embed
 * simply fills its container. */
export function embedWidthStyle(width: number | undefined): CSSProperties {
  if (width === undefined) return {};
  const rendered = `${clampEmbedWidth(width)}px`;
  return {
    width: rendered,
    maxWidth: "var(--folio-pane-w, 100%)",
    marginLeft: `calc((100% - min(${rendered}, var(--folio-pane-w, 100%))) / 2)`,
  };
}

/** Compact unless the author opted out. */
export function embedIsCompact(presentation: BaseEmbedPresentation): boolean {
  return presentation.display !== "full";
}
