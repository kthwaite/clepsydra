import { useIsMutating } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useStats } from "#/api/index";
import type { CodexFrameChromeProps } from "#/components/codex/CodexFrame";
import { shortFolio } from "#/components/codex/folio-utils";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { Sheaf } from "#/components/codex/Sheaf";
import { useCodexView } from "#/components/codex/useCodexView";
import {
  DESKTOP_NAV,
  goToView,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { useTheme } from "#/components/ThemeProvider";
import { useClock } from "#/hooks/useClock";
import { useOpenTab } from "#/hooks/useOpenTab";
import {
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useUptime } from "#/hooks/useUptime";
import { useVaultEvents } from "#/hooks/useVaultEvents";
import { cn } from "#/lib/cn";
import { formatClock, formatRelativeTime, pad2 } from "#/lib/time";
import { useUiStore } from "#/store/ui";
import { selectActiveTab, useWorkspaceStore } from "#/store/workspace";

function UptimeText() {
  const uptime = useUptime();
  return (
    <span className="flex-shrink-0 border-l border-bar-rule px-3 py-[2px] tabular-nums opacity-70">
      up {uptime}
    </span>
  );
}

function UtcClockText() {
  const clock = formatClock(useClock(), true);
  return (
    <span className="flex-shrink-0 border-l border-bar-rule px-3 py-[2px] tabular-nums">
      {clock} UTC
    </span>
  );
}

export function DesktopCodexFrame({
  bottomSlot,
  forceView,
}: CodexFrameChromeProps) {
  const { progress } = useReadingProgress();
  const navigate = useNavigate();
  const openSearch = useUiStore((s) => s.openSearch);
  const { toggle, resolvedTheme, diegetic } = useTheme();
  const dark = resolvedTheme === "dark";
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const activePath = useWorkspaceStore((s) => selectActiveTab(s)?.path);
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const { data: stats, isError: statsError } = useStats();
  const syncStatus = useVaultEvents();

  const resolved = useCodexView();
  const view = forceView ?? resolved;
  const descriptor = VIEW_REGISTRY[view];
  const folioCode =
    descriptor.folioCode ?? (activePath ? shortFolio(activePath) : "—");

  const writing = useIsMutating() > 0;

  const pages = stats?.pages ?? 0;
  const links = stats?.links_total ?? 0;
  const sync = syncStatus === "connected";
  const syncColor = sync
    ? "var(--cool)"
    : syncStatus === "connecting"
      ? "var(--warn)"
      : "var(--hot)";

  return (
    <>
      {/* ── HEADER RAIL ─────────────────────────────────────────────── */}
      <header className="order-0 flex h-8 min-w-0 flex-shrink-0 items-stretch border-b border-rule text-[11px]">
        <button
          type="button"
          onClick={() =>
            goToView("atrium", {
              navigate,
              openTab,
              activateTab,
              leaveWorkspace,
            })
          }
          className="flex flex-shrink-0 cursor-pointer items-center border-r border-rule px-3 font-sans text-[15px] font-black uppercase tracking-[0.08em] text-ink"
          aria-label="CLEPSYDRA — return to Atrium"
        >
          <span className="text-accent">C</span>LEPSYDRA
        </button>

        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 items-stretch overflow-x-auto"
        >
          {DESKTOP_NAV.map((key, i) => {
            const active = VIEW_REGISTRY[view].navRoot === key;
            return (
              <button
                key={key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() =>
                  goToView(key, {
                    navigate,
                    openTab,
                    activateTab,
                    leaveWorkspace,
                  })
                }
                className={cn(
                  "cl-mono flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-rule-soft px-3 uppercase tracking-[0.18em]",
                  active
                    ? "text-ink shadow-[inset_0_-2px_0_0_var(--accent)]"
                    : "text-ink-mute hover:text-ink",
                )}
              >
                <span className="text-[9px] text-ink-mute">{pad2(i)}</span>
                <span className="text-[10px]">{VIEW_REGISTRY[key].label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* HEADER META — minimal status that survives diegetic-off */}
        <div className="cl-mono flex shrink-0 items-stretch text-[10px]">
          <button
            type="button"
            onClick={openSearch}
            className="flex cursor-pointer items-center gap-1.5 border-l border-rule-soft px-3 text-ink-mute hover:text-ink"
          >
            <span className="text-accent">⌘K</span>
            <span className="hidden md:inline uppercase tracking-[0.16em]">
              query
            </span>
          </button>
          <button
            type="button"
            onClick={toggle}
            className="flex cursor-pointer items-center border-l border-rule-soft px-3 text-ink-mute hover:text-ink"
            aria-label={dark ? "Switch to paper mode" : "Switch to dark mode"}
            title={dark ? "Switch to paper mode" : "Switch to dark mode"}
          >
            [{dark ? "DARK" : "PAPER"}]
          </button>
        </div>
      </header>

      {/* ── SHEAF — hidden on full-surface destinations ─────────────── */}
      {descriptor.showsSheaf && (
        <Sheaf
          activeTabId={activeTabId}
          activeTabVisible={view === "folio"}
          className="order-1"
        />
      )}

      {/* ── FOOTER RAIL ─────────────────────────────────────────────── */}
      {bottomSlot
        ? createPortal(
            <footer className="cl-mono order-3 flex flex-shrink-0 items-center border-t border-rule bg-bar-bg text-[10px] text-bar-fg">
              {diegetic && (
                <span className="flex items-center gap-1.5 border-r border-bar-rule px-3 py-[2px]">
                  <span
                    className="inline-block h-[6px] w-[6px]"
                    style={{ background: syncColor }}
                    aria-hidden
                  />
                  <span className="font-medium tracking-[0.16em]">VESSEL</span>
                  <span
                    className={cn(
                      "inline-block h-[6px] w-[6px]",
                      writing ? "animate-pulse bg-accent" : "bg-ink-mute/30",
                    )}
                    aria-label={writing ? "Sending data to server" : undefined}
                    title={writing ? "Sending…" : undefined}
                  />
                </span>
              )}
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap px-3 py-[2px] opacity-80">
                FILE {folioCode} · VIEW {descriptor.label} · CORPUS {pages}/
                {links}
              </span>
              {view === "folio" && (
                <span className="flex-shrink-0 border-l border-bar-rule px-3 py-[2px] opacity-70">
                  {Math.round(Math.max(0, Math.min(1, progress)) * 100)}%
                </span>
              )}
              {diegetic && (
                <span className="hidden flex-shrink-0 border-l border-bar-rule px-3 py-[2px] opacity-70 md:inline">
                  idx {statsError ? "✗" : stats ? "✓" : "…"} · collated{" "}
                  {formatRelativeTime(stats?.last_indexed_at)}
                </span>
              )}
              <UptimeText />
              <UtcClockText />
            </footer>,
            bottomSlot,
          )
        : null}
    </>
  );
}
