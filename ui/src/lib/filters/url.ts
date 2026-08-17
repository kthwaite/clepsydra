import { type FilterFieldSpec, type FilterState, FLAG_ON } from "./model";

export interface FilterUrlOptions {
  fields: readonly FilterFieldSpec[];
  aliases?: Readonly<Record<string, string>>;
  textParam?: string;
}

function rawValues(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  return list
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseFilterSearch(
  search: Record<string, unknown>,
  opts: FilterUrlOptions,
): FilterState {
  const textParam = opts.textParam ?? "q";
  const rawText = search[textParam];
  const facets: Record<string, readonly string[]> = {};
  for (const field of opts.fields) {
    let raw = search[field.id];
    if (raw === undefined && opts.aliases) {
      for (const [alias, target] of Object.entries(opts.aliases)) {
        if (target === field.id && search[alias] !== undefined) {
          raw = search[alias];
          break;
        }
      }
    }
    if (field.kind === "flag") {
      const first =
        typeof raw === "boolean" || typeof raw === "number"
          ? String(raw)
          : rawValues(raw)[0];
      if (first === "1" || first === "true") facets[field.id] = [FLAG_ON];
      continue;
    }
    const normalize = field.normalize ?? ((v: string) => v);
    const values = [...new Set(rawValues(raw).map(normalize))];
    if (values.length === 0) continue;
    facets[field.id] = field.kind === "single" ? [values[0]] : values;
  }
  return { text: typeof rawText === "string" ? rawText : "", facets };
}

export function filterStateToSearch(
  state: FilterState,
  opts: FilterUrlOptions,
): Record<string, string | string[] | undefined> {
  const textParam = opts.textParam ?? "q";
  const out: Record<string, string | string[] | undefined> = {
    [textParam]: state.text !== "" ? state.text : undefined,
  };
  for (const field of opts.fields) {
    const values = state.facets[field.id] ?? [];
    if (values.length === 0) {
      out[field.id] = undefined;
    } else if (field.kind === "multi") {
      out[field.id] = [...values];
    } else {
      out[field.id] = values[0];
    }
  }
  return out;
}
