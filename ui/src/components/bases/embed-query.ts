import type {
  BaseFilter,
  BaseViewEvaluateRequest,
  SortKey,
} from "#/api/bases";
import { asciiCaseFold } from "./local-validation";

export interface BaseEmbedConfig {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit?: number;
}

export const EMBED_DEFAULT_LIMIT = 50;

export type NormalizedEmbedSort =
  | { mode: "inherited" }
  | { mode: "explicit"; value: SortKey[] };

export interface NormalizedEmbedConfig {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort: NormalizedEmbedSort;
  limit: number;
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
    limit: config.limit ?? EMBED_DEFAULT_LIMIT,
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
    limit: normalized.limit,
  });
}

export function baseViewEvaluationBody(
  config: BaseEmbedConfig,
): BaseViewEvaluateRequest {
  const normalized = normalizeEmbedConfiguration(config);
  return {
    ...(normalized.filter === undefined
      ? {}
      : { filter: normalized.filter }),
    ...(normalized.sort.mode === "inherited"
      ? {}
      : { sort: normalized.sort.value }),
    limit: normalized.limit,
  };
}
