import { useNavigate } from "@tanstack/react-router";
import { Pin, Plus, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useStats } from "#/api/index";
import {
  type MenuTarget,
  SheafContextMenu,
} from "#/components/codex/SheafContextMenu";
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";
import { shouldPreviewTab } from "#/components/codex/tab-preview";
import { cn } from "#/lib/cn";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import {
  orderSheafTabs,
  type Quire,
  quireColorVar,
  sheafSegments,
} from "#/store/quires";
import { useUiStore } from "#/store/ui";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

type SheafProps = {
  activeTabId: string | null;
  className?: string;
};

// Cold-open delay; once a card is showing, scrubbing to another tab is instant.
const HOVER_DELAY = 220;

export function Sheaf({ activeTabId, className }: SheafProps) {
  const navigate = useNavigate();
  const openInscribe = useUiStore((state) => state.openInscribe);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const quires = useWorkspaceStore((s) => s.quires);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const toggleQuireCollapse = useWorkspaceStore((s) => s.toggleQuireCollapse);
  const { data: stats } = useStats();

  const pageTabs = orderSheafTabs(
    tabs.filter((t) => t.type === "page"),
    quires,
  );
  const segments = sheafSegments(pageTabs, quires);

  const [hovered, setHovered] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const openTimer = useRef<number | null>(null);

  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const openMenu = (next: MenuTarget) => {
    clearOpenTimer();
    setHovered(null);
    setMenu(next);
  };

  useEffect(() => clearOpenTimer, []);

  const onTabEnter = (
    id: string,
    path: string | undefined,
    el: HTMLElement,
  ) => {
    if (!shouldPreviewTab(path, id, activeTabId)) return;
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
    navigate({ to: "/workspace" });
  };

  const hoveredPath = hovered
    ? (pageTabs.find((t) => t.id === hovered.id)?.path ?? null)
    : null;

  return (
    <div
      className={cn(
        "cl-mono cl-noscroll flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule bg-paper-2",
        className,
      )}
    >
      <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        § SHEAF
        <span className="text-ink-2">{pageTabs.length}</span>
      </span>

      {segments.map((seg) =>
        seg.kind === "tab" ? (
          <FolioTab
            key={seg.tab.id}
            tab={seg.tab}
            active={seg.tab.id === activeTabId}
            onActivate={onActivate}
            onEnter={onTabEnter}
            onLeave={onTabLeave}
            onContextMenu={(e, tabId) => {
              e.preventDefault();
              openMenu({ kind: "tab", tabId, x: e.clientX, y: e.clientY });
            }}
          />
        ) : (
          <Fragment key={seg.quire.id}>
            <button
              type="button"
              onClick={() => toggleQuireCollapse(seg.quire.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu({
                  kind: "quire",
                  quireId: seg.quire.id,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
              aria-label={`quire ${seg.quire.name}, ${seg.members.length} folios${
                seg.quire.collapsed ? ", collapsed" : ""
              }`}
              className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]"
              style={{
                color: quireColorVar(seg.quire.color),
                boxShadow: `inset 0 2px 0 0 ${quireColorVar(seg.quire.color)}`,
              }}
            >
              {seg.quire.name}
              {seg.quire.collapsed && (
                <span className="text-ink-mute">·{seg.members.length}</span>
              )}
            </button>
            {!seg.quire.collapsed &&
              seg.members.map((t) => (
                <FolioTab
                  key={t.id}
                  tab={t}
                  quire={seg.quire}
                  active={t.id === activeTabId}
                  onActivate={onActivate}
                  onEnter={onTabEnter}
                  onLeave={onTabLeave}
                  onContextMenu={(e, tabId) => {
                    e.preventDefault();
                    openMenu({
                      kind: "tab",
                      tabId,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                />
              ))}
          </Fragment>
        ),
      )}

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

      {hoveredPath && hovered && (
        <TabPreviewCard path={hoveredPath} rect={hovered.rect} />
      )}

      <span className="flex-1" />
      <span className="flex flex-shrink-0 items-center gap-2 border-l border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        <span className="text-ink-2">{stats?.pages ?? 0}</span> indexed
        <span className="border-l border-rule-soft pl-2">⌘N intake</span>
      </span>
      {menu && <SheafContextMenu target={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

type FolioTabProps = {
  tab: TabDescriptor;
  quire?: Quire;
  active: boolean;
  onActivate: (id: string) => void;
  onEnter: (id: string, path: string | undefined, el: HTMLElement) => void;
  onLeave: () => void;
  onContextMenu: (e: ReactMouseEvent, tabId: string) => void;
};

function FolioTab({
  tab: t,
  quire,
  active,
  onActivate,
  onEnter,
  onLeave,
  onContextMenu,
}: FolioTabProps) {
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);

  const kind = resolveKindFromPath(t.path ?? "");
  const onClose = (e: ReactMouseEvent) => {
    e.stopPropagation();
    closeTab(t.id);
  };
  const onPin = (e: ReactMouseEvent) => {
    e.stopPropagation();
    togglePin(t.id);
  };

  // Quire membership rules the top edge; the active accent keeps the bottom.
  const rules = [
    quire ? `inset 0 2px 0 0 ${quireColorVar(quire.color)}` : null,
    active ? "inset 0 -2px 0 0 var(--accent)" : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={() => onActivate(t.id)}
      onMouseEnter={(e) => onEnter(t.id, t.path, e.currentTarget)}
      onMouseLeave={onLeave}
      onContextMenu={(e) => onContextMenu(e, t.id)}
      title={t.path ? undefined : t.label}
      aria-label={t.label || t.path || "untitled folio"}
      className={cn(
        "group flex max-w-[240px] flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-r border-rule-soft py-1 pl-3 pr-2",
        active ? "bg-paper text-ink" : "text-ink-mute hover:text-ink",
      )}
      style={rules.length ? { boxShadow: rules.join(", ") } : undefined}
    >
      <span
        className="inline-block h-[6px] w-[6px] flex-shrink-0"
        style={{ background: kindColorVar(kind) }}
        aria-hidden
      />
      <span className="max-w-[160px] overflow-hidden text-ellipsis text-[12px]">
        {t.label || t.path || "(untitled)"}
      </span>
      <span
        onClick={onPin}
        onKeyDown={(e) => {
          if (e.key === "Enter") onPin(e as unknown as ReactMouseEvent);
        }}
        role="button"
        tabIndex={0}
        aria-label={t.pinned ? "unpin folio" : "pin folio"}
        className={cn(
          "flex-shrink-0 cursor-pointer px-[2px] leading-none transition-opacity",
          t.pinned
            ? "text-warn opacity-100"
            : "text-ink-mute opacity-0 group-hover:opacity-60 hover:!opacity-100",
        )}
      >
        <Pin size={11} fill={t.pinned ? "currentColor" : "none"} />
      </span>
      {!t.pinned && (
        <span
          onClick={onClose}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose(e as unknown as ReactMouseEvent);
          }}
          role="button"
          tabIndex={0}
          aria-label="close folio"
          className="flex-shrink-0 cursor-pointer px-[2px] leading-none text-ink-mute opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
        >
          <X size={11} />
        </span>
      )}
    </button>
  );
}
