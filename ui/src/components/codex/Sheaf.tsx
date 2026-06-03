import { useNavigate } from "@tanstack/react-router";
import { Pin, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useStats } from "#/api/index";
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";
import { shouldPreviewTab } from "#/components/codex/tab-preview";
import { cn } from "#/lib/cn";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

type SheafProps = {
  activeTabId: string | null;
};

/** Pinned tabs first, each group preserving insertion order. */
function ordered(tabs: TabDescriptor[]): TabDescriptor[] {
  return [...tabs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
}

// Cold-open delay; once a card is showing, scrubbing to another tab is instant.
const HOVER_DELAY = 220;

export function Sheaf({ activeTabId }: SheafProps) {
  const navigate = useNavigate();
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const { data: stats } = useStats();

  const pageTabs = ordered(tabs.filter((t) => t.type === "page"));

  const [hovered, setHovered] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );
  const openTimer = useRef<number | null>(null);

  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
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
    <div className="cl-mono cl-noscroll flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule bg-paper-2">
      <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        § SHEAF
        <span className="text-ink-2">{pageTabs.length}</span>
      </span>

      {pageTabs.map((t) => {
        const active = t.id === activeTabId;
        const kind = resolveKindFromPath(t.path ?? "");
        const onClose = (e: ReactMouseEvent) => {
          e.stopPropagation();
          closeTab(t.id);
        };
        const onPin = (e: ReactMouseEvent) => {
          e.stopPropagation();
          togglePin(t.id);
        };
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onActivate(t.id)}
            onMouseEnter={(e) => onTabEnter(t.id, t.path, e.currentTarget)}
            onMouseLeave={onTabLeave}
            title={t.path ? undefined : t.label}
            aria-label={t.label || t.path || "untitled folio"}
            className={cn(
              "group flex max-w-[240px] flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-r border-rule-soft py-1 pl-3 pr-2",
              active
                ? "bg-paper text-ink shadow-[inset_0_-2px_0_0_var(--accent)]"
                : "text-ink-mute hover:text-ink",
            )}
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
                  if (e.key === "Enter")
                    onClose(e as unknown as ReactMouseEvent);
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
      })}

      {hoveredPath && hovered && (
        <TabPreviewCard path={hoveredPath} rect={hovered.rect} />
      )}

      <span className="flex-1" />
      <span className="flex flex-shrink-0 items-center gap-2 border-l border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        <span className="text-ink-2">{stats?.pages ?? 0}</span> indexed
        <span className="border-l border-rule-soft pl-2">⌘N intake</span>
      </span>
    </div>
  );
}
