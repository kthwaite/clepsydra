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
import { useCallback, useEffect, useRef, useState } from "react";
import { SheafContextMenu } from "#/components/codex/SheafContextMenu";
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";
import { shouldPreviewTab } from "#/components/codex/tab-preview";
import { KindIcon } from "#/components/KindIcon";
import { useActivateTabWithFolioHistory } from "#/hooks/useFolioHistoryNavigation";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveKindFromPath } from "#/lib/kind";
import {
  type Quire,
  quireColorVar,
  sheafRuns,
  sheafSegments,
} from "#/store/quires";
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
  const pageTabs = tabs.filter((tab) => tab.type === "page");
  const runs = sheafRuns(sheafSegments(pageTabs, quires));

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

  const renderTab = (tab: TabDescriptor) => (
    <FolioTab
      key={tab.id}
      tab={tab}
      active={tab.id === activeTabId}
      dragged={tab.id === draggedTabId}
      dropEdge={
        dropFeedback?.kind === "tab" && dropFeedback.tabId === tab.id
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
  );

  return (
    <div
      ref={sheafRef}
      className={cn(
        "cl-noscroll mx-10 flex h-12 flex-shrink-0 items-stretch gap-7 overflow-x-auto text-[13.5px]",
        className,
      )}
    >
      {runs.map((run, index) =>
        run.kind === "quire" ? (
          <Segment
            key={run.quire.id}
            label={run.quire.name}
            rule={quireRule(run.quire)}
            drop={{ quireId: run.quire.id }}
          >
            <QuireHeader
              quire={run.quire}
              memberCount={run.members.length}
              highlighted={
                dropFeedback?.kind === "quire" &&
                dropFeedback.quireId === run.quire.id
              }
              setDropFeedback={setDropFeedback}
              onToggle={() => toggleQuireCollapse(run.quire.id)}
            />
            {!run.quire.collapsed && run.members.map(renderTab)}
          </Segment>
        ) : (
          <Segment
            // Loose runs have no stable id; their position is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={`loose-${index}`}
            label="Ungrouped"
            rule="var(--rule)"
            grow={index === runs.length - 1}
            drop={looseDrop(run.tabs, index === runs.length - 1)}
          >
            {run.tabs.map(renderTab)}
            {index === runs.length - 1 && (
              <button
                type="button"
                aria-label="New page"
                title="New page"
                onClick={openInscribe}
                className={cn(
                  "flex flex-shrink-0 cursor-pointer items-center rounded-full px-2.5 text-faint hover:text-accent focus-visible:text-accent",
                  FOCUS_RING_NATIVE,
                )}
              >
                <Plus aria-hidden="true" size={16} />
              </button>
            )}
          </Segment>
        ),
      )}

      {hoveredPath && hovered && (
        <TabPreviewCard path={hoveredPath} rect={hovered.rect} />
      )}
    </div>
  );
}

type SegmentDrop = Parameters<
  ReturnType<typeof useWorkspaceStore.getState>["moveTab"]
>[1];

/** Where a drop on a loose segment's own space lands: the trailing segment
 *  means "end of the row"; an earlier one means "after its last tab". */
function looseDrop(tabs: TabDescriptor[], trailing: boolean): SegmentDrop {
  const last = tabs.at(-1);
  return trailing || !last
    ? { position: "end" }
    : { tabId: last.id, position: "after" };
}

/** One C3 segment: a run of tabs over a 1px rule in its quire's hue (or the
 *  neutral rule for ungrouped tabs). Its own space is a drop target, so a
 *  drop between its tabs never falls through; the gaps between segments
 *  accept nothing. */
function Segment({
  label,
  rule,
  grow,
  drop,
  children,
}: {
  label: string;
  rule: string;
  grow?: boolean;
  drop: SegmentDrop;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const moveTab = useWorkspaceStore((s) => s.moveTab);
  const dropKey = JSON.stringify(drop);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = JSON.parse(dropKey) as SegmentDrop;
    return dropTargetForElements({
      element,
      getData: () => ({ kind: "sheaf-segment" }),
      canDrop: ({ source }) => getSheafTabId(source.data) !== null,
      onDrop: ({ source, self, location }) => {
        // Tabs and the quire label inside handle their own drops.
        if (location.current.dropTargets[0]?.element !== self.element) return;
        const sourceTabId = getSheafTabId(source.data);
        if (sourceTabId) moveTab(sourceTabId, target);
      },
    });
  }, [dropKey, moveTab]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a run of tab buttons, not form controls; a fieldset would add form semantics and default borders, so an ARIA group names the quire instead.
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cn("flex flex-shrink-0 items-stretch", grow && "flex-1")}
      style={{ boxShadow: `inset 0 -1px 0 0 ${rule}` }}
    >
      {children}
    </div>
  );
}

const quireRule = (q: Quire) =>
  `color-mix(in srgb, ${quireColorVar(q.color)} 55%, transparent)`;

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
      onDragEnter: () => setDropFeedback({ kind: "quire", quireId: quire.id }),
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
        className="flex flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap pr-2.5"
        style={{
          color: quireColorVar(quire.color),
          outline: highlighted ? "1px solid var(--accent)" : undefined,
          outlineOffset: highlighted ? "-1px" : undefined,
        }}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
        <span className="font-serif text-[17px] italic leading-none">
          {quire.name}
        </span>
        {quire.collapsed && (
          <span className="text-[12.5px] text-mute">·{memberCount}</span>
        )}
      </button>
    </SheafContextMenu>
  );
}

type FolioTabProps = {
  tab: TabDescriptor;
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
  // included — the label button alone stops short of the ✕. The quire's
  // own rule lives on its Segment.
  const rules = [
    active ? "inset 0 -2px 0 0 var(--accent)" : null,
    dropEdge === "left" ? "inset 2px 0 0 0 var(--accent)" : null,
    dropEdge === "right" ? "inset -2px 0 0 0 var(--accent)" : null,
  ].filter(Boolean);

  return (
    <div
      ref={ref}
      className={cn(
        "group flex max-w-[260px] flex-shrink-0 items-stretch whitespace-nowrap",
        active ? "font-medium text-ink" : "text-mute hover:text-ink",
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
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-md pl-2.5",
            FOCUS_RING_NATIVE,
            dragged && "opacity-50",
          )}
        >
          <KindIcon
            kind={kind}
            tone="mono"
            size={14}
            className={cn("flex-shrink-0", active && "text-accent")}
          />
          <span className="max-w-[180px] overflow-hidden text-ellipsis select-none">
            {t.label || t.path || "(untitled)"}
          </span>
        </button>
      </SheafContextMenu>
      <button
        type="button"
        onClick={onClose}
        aria-label="close folio"
        className={cn(
          "flex-shrink-0 cursor-pointer rounded-md pr-2.5 pl-1 leading-none text-faint transition-opacity hover:text-ink focus-visible:opacity-100",
          FOCUS_RING_NATIVE,
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X size={12} />
      </button>
    </div>
  );
}
