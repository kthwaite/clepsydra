import type { MouseEvent as ReactMouseEvent } from "react";
import { useStats } from "#/api/index";
import { shortFolio } from "#/components/codex/folio-utils";
import { useWorkspaceStore } from "#/store/workspace";

type SheafProps = {
  activeTabId: string;
};

export function Sheaf({ activeTabId }: SheafProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const { data: stats } = useStats();

  const pageTabs = tabs.filter((t) => t.type === "page");

  return (
    <div className="cl-noscroll flex items-stretch overflow-x-auto border-b-[1.5px] border-rule bg-paper-2">
      <span className="cl-cap cl-mono flex flex-shrink-0 items-center whitespace-nowrap border-r border-rule-soft px-3 py-1 text-[9px] tracking-[0.18em] text-ink-mute">
        § SHEAF
      </span>
      {pageTabs.map((t) => {
        const active = t.id === activeTabId;
        const onClose = (e: ReactMouseEvent) => {
          e.stopPropagation();
          closeTab(t.id);
        };
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => activateTab(t.id)}
            className={`flex flex-shrink-0 max-w-[240px] cursor-pointer items-center gap-2 whitespace-nowrap border-r border-rule-soft py-1 pl-3 pr-2 ${
              active
                ? "border-t-2 border-t-accent bg-paper text-ink"
                : "border-t-2 border-t-transparent text-ink-mute"
            }`}
          >
            <span
              className={`cl-mono text-[9px] font-bold tracking-[0.04em] ${
                active ? "text-accent-deep" : "text-ink-mute"
              }`}
            >
              {t.path ? shortFolio(t.path) : "—"}
            </span>
            <span className="max-w-[160px] overflow-hidden text-ellipsis text-[12px]">
              {t.label || t.path || "(untitled)"}
            </span>
            {pageTabs.length > 1 && (
              <span
                onClick={onClose}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onClose(e as unknown as ReactMouseEvent);
                }}
                role="button"
                tabIndex={0}
                aria-label="close folio"
                className={`cl-mono cursor-pointer px-[3px] text-[11px] leading-none text-ink-mute ${
                  active ? "opacity-100" : "opacity-50"
                }`}
              >
                ×
              </span>
            )}
          </button>
        );
      })}
      <span className="flex-1" />
      <span className="cl-mono flex flex-shrink-0 items-center border-l border-rule-soft px-3 py-1 text-[9px] text-ink-mute">
        {pageTabs.length} open · {stats?.pages ?? 0} indexed
      </span>
    </div>
  );
}
