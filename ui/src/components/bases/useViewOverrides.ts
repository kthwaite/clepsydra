import { useCallback, useState } from "react";
import {
  EMPTY_OVERRIDES,
  type GroupOverride,
  type QuickFilter,
  type ViewOverridesState,
  withGroup,
  withHiddenColumn,
  withoutHiddenColumn,
  withoutHiddenColumns,
  withoutQuickFilter,
  withQuickFilter,
} from "./view-overrides";

export type OverridesSaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "conflict"; message: string }
  | { phase: "error"; message: string };

export interface ViewOverridesModel {
  state: ViewOverridesState;
  addQuickFilter(filter: QuickFilter): void;
  removeQuickFilter(identity: string): void;
  setGroup(group: GroupOverride | undefined): void;
  hideColumn(column: string): void;
  showColumn(column: string): void;
  showHiddenColumns(): void;
  clear(): void;
}

/** Request-time overrides for one (base, view) pair; `resetKey` changes wipe them. */
export function useViewOverrides(resetKey: string): ViewOverridesModel {
  const [stored, setStored] = useState<{
    key: string;
    state: ViewOverridesState;
  }>({
    key: resetKey,
    state: EMPTY_OVERRIDES,
  });
  const state = stored.key === resetKey ? stored.state : EMPTY_OVERRIDES;
  const update = useCallback(
    (transition: (current: ViewOverridesState) => ViewOverridesState) =>
      setStored((current) => ({
        key: resetKey,
        state: transition(
          current.key === resetKey ? current.state : EMPTY_OVERRIDES,
        ),
      })),
    [resetKey],
  );
  return {
    state,
    addQuickFilter: useCallback(
      (filter) => update((s) => withQuickFilter(s, filter)),
      [update],
    ),
    removeQuickFilter: useCallback(
      (identity) => update((s) => withoutQuickFilter(s, identity)),
      [update],
    ),
    setGroup: useCallback(
      (group) => update((s) => withGroup(s, group)),
      [update],
    ),
    hideColumn: useCallback(
      (column) => update((s) => withHiddenColumn(s, column)),
      [update],
    ),
    showColumn: useCallback(
      (column) => update((s) => withoutHiddenColumn(s, column)),
      [update],
    ),
    showHiddenColumns: useCallback(
      () => update(withoutHiddenColumns),
      [update],
    ),
    clear: useCallback(() => update(() => EMPTY_OVERRIDES), [update]),
  };
}
