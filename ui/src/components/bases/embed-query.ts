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

/** How large the next request may be: a full window, unless the author's cap
 * is nearer. Zero means there is nothing left to ask for. */
export function nextWindowSize(
  cap: number | undefined,
  loaded: number,
): number {
  if (cap === undefined) return EMBED_WINDOW_ROWS;
  return Math.max(0, Math.min(EMBED_WINDOW_ROWS, cap - loaded));
}
