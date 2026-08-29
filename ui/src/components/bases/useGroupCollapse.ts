import { useCallback, useMemo, useState } from "react";
import { readCollapsedGroups, writeCollapsedGroups } from "./group-collapse";
import { getViewStateStorage } from "./view-state";

export interface GroupCollapseModel {
  collapsed: ReadonlySet<string>;
  toggle(identity: string): void;
  expand(identity: string): void;
  collapseAll(identities: readonly string[]): void;
  expandAll(): void;
}

interface StoredFold {
  key: string;
  collapsed: ReadonlySet<string>;
}

function foldFor(key: string): StoredFold {
  return { key, collapsed: readCollapsedGroups(getViewStateStorage(), key) };
}

/** Which groups are folded under `storageKey`, mirrored to localStorage. */
export function useGroupCollapse(storageKey: string): GroupCollapseModel {
  const [stored, setStored] = useState<StoredFold>(() => foldFor(storageKey));
  const collapsed = useMemo(
    () => (stored.key === storageKey ? stored : foldFor(storageKey)).collapsed,
    [stored, storageKey],
  );
  const update = useCallback(
    (transition: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
      setStored((current) => {
        const base = current.key === storageKey ? current : foldFor(storageKey);
        const next = transition(base.collapsed);
        if (next === base.collapsed) return base;
        // Idempotent, so a repeated updater call (StrictMode) is harmless.
        writeCollapsedGroups(getViewStateStorage(), storageKey, next);
        return { key: storageKey, collapsed: next };
      }),
    [storageKey],
  );
  return {
    collapsed,
    toggle: useCallback(
      (identity) =>
        update((current) => {
          const next = new Set(current);
          if (!next.delete(identity)) next.add(identity);
          return next;
        }),
      [update],
    ),
    expand: useCallback(
      (identity) =>
        update((current) => {
          if (!current.has(identity)) return current;
          const next = new Set(current);
          next.delete(identity);
          return next;
        }),
      [update],
    ),
    collapseAll: useCallback(
      (identities) => update(() => new Set(identities)),
      [update],
    ),
    expandAll: useCallback(
      () => update((current) => (current.size === 0 ? current : new Set())),
      [update],
    ),
  };
}
