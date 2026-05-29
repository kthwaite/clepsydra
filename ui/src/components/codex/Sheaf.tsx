import { useNavigate } from "@tanstack/react-router";
import { Pin, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useStats } from "#/api/index";
import { shortFolio } from "#/components/codex/folio-utils";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

type SheafProps = {
  activeTabId: string | null;
};

/** Pinned tabs first, each group preserving insertion order. */
function ordered(tabs: TabDescriptor[]): TabDescriptor[] {
  return [...tabs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
}

export function Sheaf({ activeTabId }: SheafProps) {
  const navigate = useNavigate();
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const { data: stats } = useStats();

  const pageTabs = ordered(tabs.filter((t) => t.type === "page"));

  const onActivate = (id: string) => {
    activateTab(id);
    navigate({ to: "/workspace" });
  };

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
            title={t.path ?? t.label}
            className={`group flex max-w-[240px] flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-r border-rule-soft py-1 pl-3 pr-2 ${
              active
                ? "border-t-2 border-t-accent bg-paper text-ink"
                : "border-t-2 border-t-transparent text-ink-mute hover:text-ink"
            }`}
          >
            <span
              className="inline-block h-[6px] w-[6px] flex-shrink-0"
              style={{ background: kindColorVar(kind) }}
              aria-hidden
            />
            <span
              className={`text-[9px] font-medium tracking-[0.04em] ${
                active ? "text-accent" : "text-ink-mute"
              }`}
            >
              {t.path ? shortFolio(t.path) : "—"}
            </span>
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
              className={`flex-shrink-0 cursor-pointer px-[2px] leading-none transition-opacity ${
                t.pinned
                  ? "text-warn opacity-100"
                  : "text-ink-mute opacity-0 group-hover:opacity-60 hover:!opacity-100"
              }`}
            >
              <Pin size={11} fill={t.pinned ? "currentColor" : "none"} />
            </span>
            {pageTabs.length > 1 && !t.pinned && (
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

      <span className="flex-1" />
      <span className="flex flex-shrink-0 items-center gap-2 border-l border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        <span className="text-ink-2">{stats?.pages ?? 0}</span> indexed
        <span className="border-l border-rule-soft pl-2">⌘N intake</span>
      </span>
    </div>
  );
}
