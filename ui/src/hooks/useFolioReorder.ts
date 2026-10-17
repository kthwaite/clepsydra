import { type RefObject, useCallback } from "react";
import { useReorderFeedback } from "#/components/ui/reorder-feedback";
import { type TabMoveTarget, useWorkspaceStore } from "#/store/workspace";

/** All Folio surfaces use the workspace's existing move operation, including
 * its quire membership rules. Only feedback and focus belong to the surface. */
export function useFolioReorder(root: RefObject<HTMLElement | null>) {
  const { announcement, report } = useReorderFeedback();

  const focusTab = useCallback(
    (tabId: string) => {
      const tab = useWorkspaceStore
        .getState()
        .tabs.find((item) => item.id === tabId);
      const controls = root.current?.querySelectorAll<HTMLElement>(
        "[data-folio-id], [data-quire-id]",
      );
      if (!controls) return null;
      let folio: HTMLElement | null = null;
      let quire: HTMLElement | null = null;
      for (const control of controls) {
        if (control.dataset.folioId === tabId) {
          folio = control;
          break;
        }
        if (tab?.quireId && control.dataset.quireId === tab.quireId)
          quire = control;
      }
      const target = folio ?? quire;
      // Keep the moved control visible without motion, including reduced-motion
      // users and remounts between separate quire segments.
      target?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
      return target;
    },
    [root],
  );

  const move = useCallback(
    (tabId: string, target: TabMoveTarget) => {
      const before = useWorkspaceStore.getState();
      before.moveTab(tabId, target);
      const after = useWorkspaceStore.getState();
      if (before.tabs === after.tabs) return;
      const pages = after.tabs.filter((tab) => tab.type === "page");
      const index = pages.findIndex((tab) => tab.id === tabId);
      const tab = pages[index];
      if (!tab) return;
      const quire = tab.quireId ? after.quires[tab.quireId] : undefined;
      report(
        `Moved ${tab.label || tab.path || "untitled folio"} to position ${index + 1} of ${pages.length}${quire ? ` in ${quire.name}` : ", ungrouped"}.`,
        () => focusTab(tabId),
      );
    },
    [focusTab, report],
  );

  const moveBy = useCallback(
    (tabId: string, delta: -1 | 1) => {
      const pages = useWorkspaceStore
        .getState()
        .tabs.filter((tab) => tab.type === "page");
      const index = pages.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const neighbor = pages[index + delta];
      if (!neighbor) return;
      move(tabId, {
        tabId: neighbor.id,
        position: delta === -1 ? "before" : "after",
      });
    },
    [move],
  );

  const cancel = useCallback(
    (tabId: string) => {
      report("Move cancelled. Folio order unchanged.", () => focusTab(tabId));
    },
    [focusTab, report],
  );

  return { announcement, move, moveBy, cancel };
}
