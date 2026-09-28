import type {
  BaseDetailResponse,
  BaseFilePayload,
  BaseFilter,
  BaseViewDefinition,
  FilterOp,
  SortKey,
} from "#/api/bases";
import { asciiCaseFold } from "./local-validation";

export type GroupOverride = { kind: "flat" } | { kind: "by"; field: string };

export interface QuickFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
  /** Menu item and chip text, e.g. `status is reading`. */
  label: string;
}

export interface ViewOverridesState {
  quickFilters: QuickFilter[];
  group: GroupOverride | undefined;
  hiddenColumns: string[];
  /** A request-time column order; absent when it equals the saved order. */
  columnOrder?: string[];
}

export const EMPTY_OVERRIDES: ViewOverridesState = {
  quickFilters: [],
  group: undefined,
  hiddenColumns: [],
};

export function quickFilterIdentity(filter: QuickFilter): string {
  return JSON.stringify({
    field: filter.field,
    op: filter.op,
    value: filter.value ?? null,
  });
}

export function withQuickFilter(
  state: ViewOverridesState,
  filter: QuickFilter,
): ViewOverridesState {
  const identity = quickFilterIdentity(filter);
  if (state.quickFilters.some((f) => quickFilterIdentity(f) === identity))
    return state;
  return { ...state, quickFilters: [...state.quickFilters, filter] };
}

export function withoutQuickFilter(
  state: ViewOverridesState,
  identity: string,
): ViewOverridesState {
  return {
    ...state,
    quickFilters: state.quickFilters.filter(
      (f) => quickFilterIdentity(f) !== identity,
    ),
  };
}

export function withGroup(
  state: ViewOverridesState,
  group: GroupOverride | undefined,
): ViewOverridesState {
  return { ...state, group };
}

export function withHiddenColumn(
  state: ViewOverridesState,
  column: string,
): ViewOverridesState {
  if (state.hiddenColumns.includes(column)) return state;
  return { ...state, hiddenColumns: [...state.hiddenColumns, column] };
}

export function withoutHiddenColumn(
  state: ViewOverridesState,
  column: string,
): ViewOverridesState {
  if (!state.hiddenColumns.includes(column)) return state;
  return {
    ...state,
    hiddenColumns: state.hiddenColumns.filter((c) => c !== column),
  };
}

export function withoutHiddenColumns(
  state: ViewOverridesState,
): ViewOverridesState {
  return { ...state, hiddenColumns: [] };
}

/**
 * `columns` in `order`: ids not in `columns` are dropped, columns missing from
 * `order` follow in their own order, and `title` stays first when present.
 */
export function orderColumns(
  columns: string[],
  order: string[] | undefined,
): string[] {
  if (order === undefined) return columns;
  const known = new Set(columns);
  const ordered = [...new Set(order)].filter((column) => known.has(column));
  const placed = new Set(ordered);
  const result = [...ordered, ...columns.filter((c) => !placed.has(c))];
  return known.has("title")
    ? ["title", ...result.filter((c) => c !== "title")]
    : result;
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((column, i) => column === b[i]);
}

/** Order the view's `baseColumns` as `order`; an order equal to the saved
 * one is no override, so it drops `columnOrder` instead of storing it. */
export function withColumnOrder(
  state: ViewOverridesState,
  order: string[],
  baseColumns: string[],
): ViewOverridesState {
  const next = orderColumns(baseColumns, order);
  if (sameColumns(next, baseColumns)) return withoutColumnOrder(state);
  if (state.columnOrder && sameColumns(state.columnOrder, next)) return state;
  return { ...state, columnOrder: next };
}

export function withoutColumnOrder(
  state: ViewOverridesState,
): ViewOverridesState {
  if (state.columnOrder === undefined) return state;
  const { columnOrder: _dropped, ...rest } = state;
  return rest;
}

/**
 * `columns` with `column` moved one place past its visible neighbour, hidden
 * columns keeping their slots; undefined when it cannot move that way —
 * `title`, a missing or hidden column, an edge, or a `title` neighbour.
 */
export function movedColumnOrder(
  columns: string[],
  hidden: string[],
  column: string,
  delta: -1 | 1,
): string[] | undefined {
  if (column === "title") return undefined;
  const visible = columns.filter((c) => !hidden.includes(c));
  const at = visible.indexOf(column);
  if (at < 0) return undefined;
  const neighbour = visible[at + delta];
  if (neighbour === undefined || neighbour === "title") return undefined;
  const rest = columns.filter((c) => c !== column);
  const slot = rest.indexOf(neighbour) + (delta > 0 ? 1 : 0);
  return [...rest.slice(0, slot), column, ...rest.slice(slot)];
}

export function hasOverrides(
  state: ViewOverridesState,
  sort: SortKey[] | undefined,
): boolean {
  return (
    state.quickFilters.length > 0 ||
    state.group !== undefined ||
    state.hiddenColumns.length > 0 ||
    state.columnOrder !== undefined ||
    (sort !== undefined && sort.length > 0)
  );
}

export function toFilter(filter: QuickFilter): BaseFilter {
  return filter.value === undefined
    ? { field: filter.field, op: filter.op }
    : { field: filter.field, op: filter.op, value: filter.value };
}

function conjuncts(filter: BaseFilter | undefined): BaseFilter[] {
  if (filter === undefined) return [];
  return "all" in filter ? filter.all : [filter];
}

/** AND the quick filters after `base`; a lone conjunct stays bare. */
export function composeQuickFilters(
  base: BaseFilter | undefined,
  quick: QuickFilter[],
): BaseFilter | undefined {
  if (quick.length === 0) return base;
  const all = [...conjuncts(base), ...quick.map(toFilter)];
  return all.length === 1 ? all[0] : { all };
}

export function groupOverrideParam(
  group: GroupOverride | undefined,
): string | undefined {
  if (group === undefined) return undefined;
  return group.kind === "flat" ? "" : group.field;
}

/** Materialise the overrides into the saved view definition. */
export function applyOverridesToView(
  view: BaseViewDefinition,
  state: ViewOverridesState,
  sort: SortKey[] | undefined,
  renderedColumns: string[],
): BaseViewDefinition {
  const next: BaseViewDefinition = { ...view };
  if (state.quickFilters.length > 0) {
    next.filter = composeQuickFilters(
      view.filter ?? undefined,
      state.quickFilters,
    );
  }
  if (state.group?.kind === "by") next.group_by = state.group.field;
  if (state.group?.kind === "flat") delete next.group_by;
  if (sort !== undefined && sort.length > 0) next.sort = sort;
  if (state.columnOrder !== undefined || state.hiddenColumns.length > 0) {
    next.columns = orderColumns(renderedColumns, state.columnOrder).filter(
      (c) => !state.hiddenColumns.includes(c),
    );
  }
  return next;
}

/** The PUT body's `definition`: the detail response minus response-only
 * fields, with `view` replacing the saved view of the same name. */
export function definitionPayload(
  detail: BaseDetailResponse,
  view: BaseViewDefinition,
): BaseFilePayload {
  const target = asciiCaseFold(view.name);
  return {
    name: detail.name,
    ...(detail.description == null ? {} : { description: detail.description }),
    ...(detail.title_template == null
      ? {}
      : { title_template: detail.title_template }),
    ...(detail.filter == null ? {} : { filter: detail.filter }),
    ...(detail.preview === undefined || detail.preview.length === 0
      ? {}
      : { preview: detail.preview }),
    properties: detail.properties ?? [],
    views: (detail.views ?? []).map((candidate) =>
      asciiCaseFold(candidate.name) === target ? view : candidate,
    ),
  };
}
