import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { Plus, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { SheafContextMenu } from "#/components/codex/SheafContextMenu";
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";
import { shouldPreviewTab } from "#/components/codex/tab-preview";
import { useActivateTabWithFolioHistory } from "#/hooks/useFolioHistoryNavigation";
import { cn } from "#/lib/cn";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import { type Quire, quireColorVar, sheafSegments } from "#/store/quires";
import { useUiStore } from "#/store/ui";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

type SheafProps = {
  activeTabId: string | null;
  /** Whether the active tab's page is the one rendered in the content window.
   * True on Folio; false on the other sheaf-bearing views (Tasking,
   * Gazetteer), where the active tab previews like any other. */
  activeTabVisible?: boolean;
  className?: string;
};

// Cold-open delay; once a card is showing, scrubbing to another tab is instant.
const HOVER_DELAY = 220;

type SheafTabDragData = {
  kind: "sheaf-tab";
  tabId: string;
};

type SheafDropFeedback =
  | { kind: "tab"; tabId: string; edge: "left" | "right" }
  | { kind: "quire"; quireId: string }
  | null;

function getSheafTabId(data: Record<string, unknown>): string | null {
  return data.kind === "sheaf-tab" && typeof data.tabId === "string"
    ? data.tabId
    : null;
}

export function Sheaf({
  activeTabId,
  activeTabVisible = true,
  className,
}: SheafProps) {
  const openInscribe = useUiStore((state) => state.openInscribe);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const quires = useWorkspaceStore((s) => s.quires);
  const activateTab = useActivateTabWithFolioHistory();
  const toggleQuireCollapse = useWorkspaceStore((s) => s.toggleQuireCollapse);
  const moveTab = useWorkspaceStore((s) => s.moveTab);

  const pageTabs = tabs.filter((tab) => tab.type === "page");
  const segments = sheafSegments(pageTabs, quires);

  const [hovered, setHovered] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropFeedback, setDropFeedback] = useState<SheafDropFeedback>(null);
  const sheafRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  useEffect(() => clearOpenTimer, [clearOpenTimer]);

  const onTabDndStart = useCallback(
    (tabId: string) => {
      clearOpenTimer();
      setHovered(null);
      setDraggedTabId(tabId);
      setDropFeedback(null);
    },
    [clearOpenTimer],
  );

  const onTabDndEnd = useCallback(() => {
    clearOpenTimer();
    setHovered(null);
    setDraggedTabId(null);
    setDropFeedback(null);
  }, [clearOpenTimer]);

  const onTabEnter = (
    id: string,
    path: string | undefined,
    el: HTMLElement,
  ) => {
    if (draggedTabId !== null) return;
    if (!shouldPreviewTab(path, id, activeTabId, activeTabVisible)) return;
    clearOpenTimer();
    const show = () => setHovered({ id, rect: el.getBoundingClientRect() });
    // Instant-scrub: if a card is already open, switch with no re-delay.
    if (hovered) {
      show();
    } else {
      openTimer.current = window.setTimeout(show, HOVER_DELAY);
    }
  };

  const onTabLeave = () => {
    clearOpenTimer();
    setHovered(null);
  };

  const onActivate = (id: string) => {
    clearOpenTimer();
    setHovered(null);
    activateTab(id);
  };

  const hoveredPath = hovered
    ? (pageTabs.find((t) => t.id === hovered.id)?.path ?? null)
    : null;

  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => getSheafTabId(source.data) !== null,
        onDragStart: ({ source }) => {
          const sourceTabId = getSheafTabId(source.data);
          if (sourceTabId) onTabDndStart(sourceTabId);
        },
        onDrop: onTabDndEnd,
      }),
    [onTabDndEnd, onTabDndStart],
  );

  useEffect(() => {
    const element = sheafRef.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ kind: "sheaf-background" }),
      canDrop: ({ source }) => getSheafTabId(source.data) !== null,
      onDrop: ({ source, self, location }) => {
        if (location.current.dropTargets[0]?.element !== self.element) return;
        const sourceTabId = getSheafTabId(source.data);
        if (sourceTabId) moveTab(sourceTabId, { position: "end" });
      },
    });
  }, [moveTab]);

  return (
    <div
      ref={sheafRef}
      className={cn(
        "cl-mono cl-noscroll flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule bg-paper-2",
        className,
      )}
    >
      <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        <span className="text-ink-2">{pageTabs.length} tabs</span>
      </span>

      {segments.map((seg) =>
        seg.kind === "tab" ? (
          <FolioTab
            key={seg.tab.id}
            tab={seg.tab}
            active={seg.tab.id === activeTabId}
            dragged={seg.tab.id === draggedTabId}
            dropEdge={
              dropFeedback?.kind === "tab" &&
              dropFeedback.tabId === seg.tab.id
                ? dropFeedback.edge
                : null
            }
            setDropFeedback={setDropFeedback}
            onDndStart={onTabDndStart}
            onDndEnd={onTabDndEnd}
            onActivate={onActivate}
            onEnter={onTabEnter}
            onLeave={onTabLeave}
          />
        ) : (
          <Fragment key={seg.quire.id}>
            <QuireHeader
              quire={seg.quire}
              memberCount={seg.members.length}
              highlighted={
                dropFeedback?.kind === "quire" &&
                dropFeedback.quireId === seg.quire.id
              }
              setDropFeedback={setDropFeedback}
              onToggle={() => toggleQuireCollapse(seg.quire.id)}
            />
            {!seg.quire.collapsed &&
              seg.members.map((t) => (
                <FolioTab
                  key={t.id}
                  tab={t}
                  quire={seg.quire}
                  active={t.id === activeTabId}
                  dragged={t.id === draggedTabId}
                  dropEdge={
                    dropFeedback?.kind === "tab" &&
                    dropFeedback.tabId === t.id
                      ? dropFeedback.edge
                      : null
                  }
                  setDropFeedback={setDropFeedback}
                  onDndStart={onTabDndStart}
                  onDndEnd={onTabDndEnd}
                  onActivate={onActivate}
                  onEnter={onTabEnter}
                  onLeave={onTabLeave}
                />
              ))}
          </Fragment>
        ),
      )}

      {hoveredPath && hovered && (
        <TabPreviewCard path={hoveredPath} rect={hovered.rect} />
      )}

      <span className="flex-1" />
      <span className="flex flex-shrink-0 items-center gap-2 border-l border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        <button
          type="button"
          aria-label="New page"
          title="New page"
          onClick={openInscribe}
          className="flex flex-shrink-0 cursor-pointer items-center gap-1 border-r border-rule-soft px-2.5 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          <Plus aria-hidden="true" size={11} />
          New
        </button>
      </span>
    </div>
  );
}

type QuireHeaderProps = {
  quire: Quire;
  memberCount: number;
  highlighted: boolean;
  setDropFeedback: (feedback: SheafDropFeedback) => void;
  onToggle: () => void;
};

function QuireHeader({
  quire,
  memberCount,
  highlighted,
  setDropFeedback,
  onToggle,
}: QuireHeaderProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const moveTab = useWorkspaceStore((s) => s.moveTab);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ kind: "sheaf-quire", quireId: quire.id }),
      canDrop: ({ source }) => getSheafTabId(source.data) !== null,
      onDragEnter: () =>
        setDropFeedback({ kind: "quire", quireId: quire.id }),
      onDragLeave: () => setDropFeedback(null),
      onDrop: ({ source }) => {
        setDropFeedback(null);
        const sourceTabId = getSheafTabId(source.data);
        if (sourceTabId) moveTab(sourceTabId, { quireId: quire.id });
      },
    });
  }, [moveTab, quire.id, setDropFeedback]);

  return (
    <SheafContextMenu target={{ kind: "quire", quireId: quire.id }}>
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-label={`quire ${quire.name}, ${memberCount} folios${
          quire.collapsed ? ", collapsed" : ""
        }`}
        className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]"
        style={{
          color: quireColorVar(quire.color),
          boxShadow: `inset 0 2px 0 0 ${quireColorVar(quire.color)}`,
          outline: highlighted ? "1px solid var(--accent)" : undefined,
          outlineOffset: highlighted ? "-1px" : undefined,
        }}
      >
        {quire.name}
        {quire.collapsed && (
          <span className="text-ink-mute">·{memberCount}</span>
        )}
      </button>
    </SheafContextMenu>
  );
}

type FolioTabProps = {
  tab: TabDescriptor;
  quire?: Quire;
  active: boolean;
  dragged: boolean;
  dropEdge: "left" | "right" | null;
  setDropFeedback: (feedback: SheafDropFeedback) => void;
  onDndStart: (tabId: string) => void;
  onActivate: (id: string) => void;
  onDndEnd: () => void;
  onEnter: (id: string, path: string | undefined, el: HTMLElement) => void;
  onLeave: () => void;
};

function FolioTab({
  tab: t,
  quire,
  active,
  dragged,
  dropEdge,
  setDropFeedback,
  onDndStart,
  onDndEnd,
  onActivate,
  onEnter,
  onLeave,
}: FolioTabProps) {
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const dragHandleRef = useRef<HTMLButtonElement>(null);
  const moveTab = useWorkspaceStore((s) => s.moveTab);
  const ref = useRef<HTMLDivElement>(null);

  const kind = resolveKindFromPath(t.path ?? "");
  const onClose = (e: ReactMouseEvent) => {
    e.stopPropagation();
    closeTab(t.id);
  };

  useEffect(() => {
    const element = ref.current;
    const dragHandle = dragHandleRef.current;
    if (!element || !dragHandle) return;

    return combine(
      draggable({
        element,
        dragHandle,
        getInitialData: (): SheafTabDragData => ({
          kind: "sheaf-tab",
          tabId: t.id,
        }),
        onDragStart: () => onDndStart(t.id),
        onDrop: onDndEnd,
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => getSheafTabId(source.data) !== null,
        getData: ({ input }) =>
          attachClosestEdge(
            { kind: "sheaf-tab-target", tabId: t.id },
            { element, input, allowedEdges: ["left", "right"] },
          ),
        onDragEnter: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          setDropFeedback(
            edge === "left" || edge === "right"
              ? { kind: "tab", tabId: t.id, edge }
              : null,
          );
        },
        onDrag: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          setDropFeedback(
            edge === "left" || edge === "right"
              ? { kind: "tab", tabId: t.id, edge }
              : null,
          );
        },
        onDragLeave: () => setDropFeedback(null),
        onDrop: ({ source, self }) => {
          setDropFeedback(null);
          const sourceTabId = getSheafTabId(source.data);
          const edge = extractClosestEdge(self.data);
          if (!sourceTabId || (edge !== "left" && edge !== "right")) return;
          moveTab(sourceTabId, {
            tabId: t.id,
            position: edge === "left" ? "before" : "after",
          });
        },
      }),
    );
  }, [moveTab, onDndEnd, onDndStart, setDropFeedback, t.id]);
  // Rules paint on the wrapper so they span the full tab, close control
  // included — the label button alone stops short of the ✕.
  const rules = [
    quire ? `inset 0 2px 0 0 ${quireColorVar(quire.color)}` : null,
    active ? "inset 0 -2px 0 0 var(--accent)" : null,
    dropEdge === "left" ? "inset 2px 0 0 0 var(--accent)" : null,
    dropEdge === "right" ? "inset -2px 0 0 0 var(--accent)" : null,
  ].filter(Boolean);

  return (
    <div
      ref={ref}
      className={cn(
        "group flex max-w-[240px] flex-shrink-0 items-stretch whitespace-nowrap border-r border-rule-soft",
        active ? "bg-paper text-ink" : "text-ink-mute hover:text-ink",
      )}
      style={rules.length ? { boxShadow: rules.join(", ") } : undefined}
    >
      <SheafContextMenu target={{ kind: "tab", tabId: t.id }}>
        <button
          ref={dragHandleRef}
          type="button"
          onClick={() => onActivate(t.id)}
          onMouseEnter={(e) => onEnter(t.id, t.path, e.currentTarget)}
          onMouseLeave={onLeave}
          title={t.path ? undefined : t.label}
          aria-label={t.label || t.path || "untitled folio"}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 py-1 pl-3",
            dragged && "opacity-50",
          )}
        >
          <span
            className="inline-block h-[6px] w-[6px] flex-shrink-0"
            style={{ background: kindColorVar(kind) }}
            aria-hidden
          />
          <span className="max-w-[160px] overflow-hidden text-ellipsis text-[12px] select-none">
            {t.label || t.path || "(untitled)"}
          </span>
        </button>
      </SheafContextMenu>
      <button
        type="button"
        onClick={onClose}
        aria-label="close folio"
        className="flex-shrink-0 cursor-pointer px-2 leading-none text-ink-mute opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}
