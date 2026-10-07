// One spec per URL-backed filter screen. The facets are defined once, beside
// the screen; the URL codec and the FilterBar fields both come from them.

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import type {
  FacetOption,
  FilterField,
  FilterFieldSpec,
  FilterState,
} from "./model";
import {
  canonicalizeFilterSearch,
  type FilterUrlOptions,
  mergeFilterSearch,
  parseFilterSearch,
  shouldReplaceFilterHistory,
} from "./url";

/** A facet: its URL codec plus its FilterBar label. Fixed options live here;
 *  data-derived ones are added at render by `facetFields`. */
export interface FacetDef extends FilterFieldSpec {
  label: string;
  options?: readonly FacetOption[];
}

export interface FilterRouteSpec<TTo extends string> {
  to: TTo;
  facets: readonly FacetDef[];
  aliases?: FilterUrlOptions["aliases"];
  textParam?: string;
  /** Search keys written on every filter change, e.g. a page reset. */
  resetOnChange?: Readonly<Record<string, unknown>>;
}

export interface FilterRoute<TTo extends string> {
  to: TTo;
  url: FilterUrlOptions;
  parse: (search: Record<string, unknown>) => FilterState;
  validateSearch: <TSearch extends Record<string, unknown>>(
    search: TSearch,
  ) => TSearch & Record<string, string | string[] | undefined>;
  navigation: (
    next: FilterState,
    previous: FilterState,
  ) => {
    to: TTo;
    search: <TSearch extends Record<string, unknown>>(
      current: TSearch,
    ) => TSearch & Record<string, unknown>;
    replace: boolean;
  };
}

export function defineFilterRoute<const TTo extends string>(
  spec: FilterRouteSpec<TTo>,
): FilterRoute<TTo> {
  const url: FilterUrlOptions = {
    fields: spec.facets,
    aliases: spec.aliases,
    textParam: spec.textParam,
  };
  const reset = spec.resetOnChange ?? {};
  return {
    to: spec.to,
    url,
    parse: (search) => parseFilterSearch(search, url),
    validateSearch: (search) => canonicalizeFilterSearch(search, url),
    navigation: (next, previous) => ({
      to: spec.to,
      search: (current) => ({
        ...mergeFilterSearch(current, next, url),
        ...reset,
      }),
      replace: shouldReplaceFilterHistory(next, previous),
    }),
  };
}

/** FilterBar fields in facet order. `options` supplies data-derived options
 *  by facet id; a facet without an entry keeps its fixed options. */
export function facetFields(
  facets: readonly FacetDef[],
  options: Readonly<Record<string, readonly FacetOption[]>> = {},
): FilterField[] {
  return facets.map((facet) => ({
    ...facet,
    options: options[facet.id] ?? facet.options ?? [],
  }));
}

/** The route's filter state, parsed once per search, and its change handler. */
export function useFilterRoute<TTo extends string>(
  route: FilterRoute<TTo>,
  search: Record<string, unknown>,
) {
  const navigate = useNavigate();
  const filterState = useMemo(() => route.parse(search), [route, search]);
  const onFilterChange = useCallback(
    (next: FilterState) => {
      // TTo is generic here, so the router cannot check it; each spec names
      // a literal registered path.
      void navigate(
        route.navigation(next, filterState) as unknown as Parameters<
          typeof navigate
        >[0],
      );
    },
    [navigate, route, filterState],
  );
  return { filterState, onFilterChange };
}
