import type { BaseFilter, BaseViewEvaluateRequest, SortKey } from "#/api/bases";
import { asciiCaseFold } from "./local-validation";

export interface BaseEmbedConfig {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit?: number;
}

export type NormalizedEmbedSort =
  | { mode: "inherited" }
  | { mode: "explicit"; value: SortKey[] };

export interface NormalizedEmbedConfig {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort: NormalizedEmbedSort;
  /** The author's ceiling on the whole result; absent means the true total. */
  limit: number | undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return normalized;
}

function canonicalFilter(filter: BaseFilter): BaseFilter {
  return canonicalize(filter) as BaseFilter;
}

function canonicalSort(sort: SortKey[]): SortKey[] {
  return canonicalize(sort) as SortKey[];
}

export function normalizeEmbedConfiguration(
  config: BaseEmbedConfig,
): NormalizedEmbedConfig {
  return {
    base: config.base,
    view: asciiCaseFold(config.view),
    ...(config.filter === undefined
      ? {}
      : { filter: canonicalFilter(config.filter) }),
    sort:
      config.sort === undefined
        ? { mode: "inherited" }
        : { mode: "explicit", value: canonicalSort(config.sort) },
    limit: config.limit,
  };
}

export function predicateIdentity(config: BaseEmbedConfig): string {
  const normalized = normalizeEmbedConfiguration(config);
  return JSON.stringify({
    slug: normalized.base,
    view: normalized.view,
    filter: normalized.filter ?? null,
  });
}

export function capabilityIdentity(
  config: BaseEmbedConfig,
  revision: string,
): string {
  return JSON.stringify({ predicate: predicateIdentity(config), revision });
}

export function queryIdentity(config: BaseEmbedConfig): string {
  const normalized = normalizeEmbedConfiguration(config);
  return JSON.stringify({
    predicate: predicateIdentity(config),
    sort: normalized.sort,
    // `null` is "no author cap", which scrolls to the true total — a
    // different result from a cap that happens to equal one window.
    limit: normalized.limit ?? null,
  });
}

export function baseViewEvaluationBody(
  config: BaseEmbedConfig,
  window: { limit: number; offset: number },
): BaseViewEvaluateRequest {
  const normalized = normalizeEmbedConfiguration(config);
  return {
    ...(normalized.filter === undefined ? {} : { filter: normalized.filter }),
    ...(normalized.sort.mode === "inherited"
      ? {}
      : { sort: normalized.sort.value }),
    limit: window.limit,
    offset: window.offset,
  };
}

/** Rows fetched per scroll window. The author's `limit`, when set, is a hard
 * ceiling on the whole result; this is only how much of it arrives at once. */
export const EMBED_WINDOW_ROWS = 50;

/** The most rows one embed will hold at once.
 *
 * The scroller keeps every loaded row in the document, so something has to
 * bound it: past this many rows a filter is the answer, not more scrolling. */
export const EMBED_SCROLL_CEILING = 1000;

/** Why a scroll stopped short of the total, if it did. */
export type EmbedScrollCap = "author" | "ceiling";

/** How large the next request may be: a full window, unless the author's cap
 * or the ceiling is nearer. Zero means there is nothing left to ask for. */
export function nextWindowSize(
  cap: number | undefined,
  loaded: number,
): number {
  const ceiling = Math.max(0, EMBED_SCROLL_CEILING - loaded);
  const allowed = cap === undefined ? ceiling : Math.min(ceiling, cap - loaded);
  return Math.max(0, Math.min(EMBED_WINDOW_ROWS, allowed));
}

/** Which bound ended the scroll, when the reader has not reached the total. */
export function embedScrollCap(
  cap: number | undefined,
  loaded: number,
): EmbedScrollCap | undefined {
  if (nextWindowSize(cap, loaded) > 0) return undefined;
  if (cap !== undefined && loaded >= cap) return "author";
  return "ceiling";
}
