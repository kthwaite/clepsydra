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

export function hasOverrides(
  state: ViewOverridesState,
  sort: SortKey[] | undefined,
): boolean {
  return (
    state.quickFilters.length > 0 ||
    state.group !== undefined ||
    state.hiddenColumns.length > 0 ||
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
  if (state.hiddenColumns.length > 0) {
    next.columns = renderedColumns.filter(
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
