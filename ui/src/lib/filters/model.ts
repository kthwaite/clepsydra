export type FilterFieldKind = "multi" | "single" | "flag";
export const FLAG_ON = "1";

export interface FilterFieldSpec {
  id: string;
  kind: FilterFieldKind;
  normalize?: (raw: string) => string;
}

export interface FacetOption {
  value: string;
  label?: string;
}

export interface FilterField extends FilterFieldSpec {
  label: string;
  options: readonly FacetOption[];
}

export interface FilterState {
  text: string;
  facets: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_FILTER_STATE: FilterState = { text: "", facets: {} };

export function activeFacets(
  state: FilterState,
): [string, readonly string[]][] {
  return Object.entries(state.facets).filter(([, values]) => values.length > 0);
}

export function isFilterActive(state: FilterState): boolean {
  return state.text.trim() !== "" || activeFacets(state).length > 0;
}

export function setText(state: FilterState, text: string): FilterState {
  return { ...state, text };
}

function withFacet(
  state: FilterState,
  fieldId: string,
  values: readonly string[],
): FilterState {
  const facets = { ...state.facets };
  if (values.length === 0) {
    delete facets[fieldId];
  } else {
    facets[fieldId] = values;
  }
  return { ...state, facets };
}

export function toggleFacetValue(
  state: FilterState,
  field: Pick<FilterField, "id" | "kind">,
  value: string,
): FilterState {
  const current = state.facets[field.id] ?? [];
  if (field.kind === "flag") {
    return withFacet(state, field.id, current.length > 0 ? [] : [FLAG_ON]);
  }
  if (field.kind === "single") {
    return withFacet(state, field.id, current[0] === value ? [] : [value]);
  }
  return withFacet(
    state,
    field.id,
    current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value],
  );
}

export function removeFacetValue(
  state: FilterState,
  fieldId: string,
  value: string,
): FilterState {
  const current = state.facets[fieldId] ?? [];
  return withFacet(
    state,
    fieldId,
    current.filter((v) => v !== value),
  );
}

export function clearAllFacets(state: FilterState): FilterState {
  return { ...state, facets: {} };
}

export function clearFilter(_state: FilterState): FilterState {
  return EMPTY_FILTER_STATE;
}

export type FacetAccessor<T> = (item: T) => readonly string[];

export interface ClientFilterConfig<T> {
  textHay: (item: T) => string;
  accessors: Readonly<Record<string, FacetAccessor<T>>>;
}

export function applyClientFilter<T>(
  items: readonly T[],
  state: FilterState,
  config: ClientFilterConfig<T>,
): T[] {
  if (!isFilterActive(state)) return [...items];
  const q = state.text.trim().toLowerCase();
  const facets = activeFacets(state).filter(([id]) => id in config.accessors);
  return items.filter((item) => {
    for (const [id, values] of facets) {
      const itemValues = config.accessors[id](item);
      if (!values.some((v) => itemValues.includes(v))) return false;
    }
    if (q === "") return true;
    return config.textHay(item).toLowerCase().includes(q);
  });
}
