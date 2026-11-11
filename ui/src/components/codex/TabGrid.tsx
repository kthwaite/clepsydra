import { Network } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { usePageBaseProperties } from "#/api/bases";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import { PreviewBody } from "#/components/codex/PreviewBody";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useActivateTabWithFolioHistory } from "#/hooks/useFolioHistoryNavigation";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

const PagePreview = memo(function PagePreview({ path }: { path: string }) {
  const { data: page } = usePage(path);
  const { data: backlinks } = useBacklinks(path);
  const projection = usePageBaseProperties(page?.meta.id ?? "");
  return (
    <PreviewBody
      path={path}
      page={page}
      backlinks={backlinks}
      preview={projection.data?.preview}
      previewPending={projection.isPending}
      previewError={projection.isError}
      showTags={false}
    />
  );
});

function VisiblePagePreview({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    if (visible || !host.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div ref={host} className="h-52 overflow-hidden">
      {visible ? (
        <PagePreview path={path} />
      ) : (
        <p className="p-5 text-mute">{path}</p>
      )}
    </div>
  );
}

export function TabGrid({ onClose }: { onClose: () => void }) {
  const tabs = useWorkspaceStore((state) => state.tabs);
  const quires = useWorkspaceStore((state) => state.quires);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const closeTabs = useWorkspaceStore((state) => state.closeTabs);
  const createQuire = useWorkspaceStore((state) => state.createQuire);
  const addTabsToQuire = useWorkspaceStore((state) => state.addTabsToQuire);
  const activateTab = useActivateTabWithFolioHistory();
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [name, setName] = useState("");
  const [targetQuire, setTargetQuire] = useState("");
  const doneButton = useRef<HTMLButtonElement>(null);
  const selectedTabs = tabs.filter((tab) => selection.has(tab.id));
  const selectedIds = selectedTabs.map((tab) => tab.id);
  const hasGraph = selectedTabs.some((tab) => tab.type === "graph");
  const canGroup = selectedIds.length > 0 && !hasGraph;
  const existingQuires = Object.values(quires);

  function toggleSelection(id: string) {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function close(tabIds: readonly string[]) {
    // The pressed control may disappear or become disabled after closing.
    // Keep keyboard focus inside the dialog so Escape still works.
    doneButton.current?.focus();
    closeTabs(tabIds);
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="All tabs"
      description={`${tabs.length} open tabs, including collapsed quires.`}
      size="full"
      className="fixed inset-0 h-dvh max-h-none max-w-none rounded-xl bg-ground"
      footer={
        <Button ref={doneButton} variant="primary" onPress={onClose}>
          Done
        </Button>
      }
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p role="status">{selectedIds.length} selected</p>
        <Button
          size="sm"
          isDisabled={tabs.length === 0}
          onPress={() => setSelection(new Set(tabs.map((tab) => tab.id)))}
        >
          Select all
        </Button>
        <Button
          size="sm"
          isDisabled={selectedIds.length === 0}
          onPress={() => {
            doneButton.current?.focus();
            setSelection(new Set());
          }}
        >
          Clear selection
        </Button>
        <Button
          size="sm"
          variant="danger"
          isDisabled={selectedIds.length === 0}
          onPress={() => close(selectedIds)}
        >
          Close selected
        </Button>
      </div>
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canGroup || !name.trim()) return;
            doneButton.current?.focus();
            createQuire(selectedIds, name.trim());
            setName("");
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            New quire name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={cn(
                "h-9 rounded-xl bg-sink px-3 text-ink",
                FOCUS_RING_NATIVE,
              )}
            />
          </label>
          <Button type="submit" isDisabled={!canGroup || !name.trim()}>
            New quire
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Existing quire
            <select
              value={quires[targetQuire] ? targetQuire : ""}
              onChange={(event) => setTargetQuire(event.target.value)}
              disabled={existingQuires.length === 0}
              className={cn(
                "h-9 rounded-xl bg-sink px-3 text-ink disabled:opacity-45",
                FOCUS_RING_NATIVE,
              )}
            >
              <option value="">Choose a quire</option>
              {existingQuires.map((quire) => (
                <option key={quire.id} value={quire.id}>
                  {quire.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            isDisabled={!canGroup || !quires[targetQuire]}
            onPress={() => addTabsToQuire(selectedIds, targetQuire)}
          >
            Add to quire
          </Button>
        </div>
      </div>
      {hasGraph && (
        <p className="mb-5 text-mute">
          Graph tabs cannot join a quire. Deselect them to group pages.
        </p>
      )}
      {tabs.length === 0 ? (
        <p className="py-12 text-center text-mute">No open tabs.</p>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tabs.map((tab) => (
            <li
              key={tab.id}
              className="min-w-0 overflow-hidden rounded-xl bg-raise"
            >
              <div className="relative">
                <div
                  inert
                  aria-hidden="true"
                  className="pointer-events-none select-none"
                >
                  {tab.type === "page" && tab.path ? (
                    <VisiblePagePreview path={tab.path} />
                  ) : (
                    <div className="flex h-52 flex-col items-center justify-center gap-3 bg-sink text-mute">
                      <Network size={48} />
                      <span>Graph</span>
                    </div>
                  )}
                </div>
                <div className="px-4 py-3">
                  <p className="truncate font-medium text-ink">{tab.label}</p>
                  <div className="flex min-h-5 flex-wrap gap-x-3 text-sm text-mute">
                    {tab.id === activeTabId && (
                      <span className="text-accent">Active tab</span>
                    )}
                    {tab.quireId && quires[tab.quireId] && (
                      <span>{quires[tab.quireId].name}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Switch to ${tab.label}`}
                  aria-current={tab.id === activeTabId ? "page" : undefined}
                  className={cn(
                    "absolute inset-0 cursor-pointer rounded-xl",
                    FOCUS_RING_NATIVE,
                  )}
                  onClick={() =>
                    runWorkspaceTransition(() => {
                      activateTab(tab.id);
                      onClose();
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-2 px-4 pb-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={selection.has(tab.id)}
                    onChange={() => toggleSelection(tab.id)}
                    aria-label={`Select ${tab.label}`}
                    className={cn("size-4 accent-accent", FOCUS_RING_NATIVE)}
                  />
                  Select
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Close ${tab.label}`}
                  onPress={() => close([tab.id])}
                >
                  Close
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
