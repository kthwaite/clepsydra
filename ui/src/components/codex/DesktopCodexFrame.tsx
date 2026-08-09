import { useIsMutating } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useStats } from "#/api/index";
import type { CodexFrameChromeProps } from "#/components/codex/CodexFrame";
import { shortFolio } from "#/components/codex/folio-utils";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { Sheaf } from "#/components/codex/Sheaf";
import {
  type CodexView,
  resolveCodexView,
} from "#/components/codex/useCodexView";
import { useTheme } from "#/components/ThemeProvider";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
import { useClock } from "#/hooks/useClock";
import { useUptime } from "#/hooks/useUptime";
import { useVaultEvents } from "#/hooks/useVaultEvents";
import { cn } from "#/lib/cn";
import { formatClock, formatRelativeTime, pad2 } from "#/lib/time";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

/** Nav order + diegetic index numbers. */
const NAV: ReadonlyArray<readonly [CodexView, string]> = [
  ["atrium", "ATRIUM"],
  ["folio", "FOLIO"],
  ["gazetteer", "GAZETTEER"],
  ["constellation", "CONSTELLATION"],
  ["tasking", "TASKING"],
  ["academic", "ACADEMIC"],
  ["bases", "BASES"],
  ["docs", "DOCS"],
];

export function DesktopCodexFrame({
  bottomSlot,
  forceView,
  pathname,
}: CodexFrameChromeProps) {
  const { progress } = useReadingProgress();
  const navigate = useNavigate();
  const openSearch = useUiStore((s) => s.openSearch);
  const openSettings = useUiStore((s) => s.openSettings);
  const settingsOpen = useUiStore((s) => s.isSettingsOpen);
  const { toggle, resolvedTheme, diegetic } = useTheme();
  const dark = resolvedTheme === "dark";
  const { tabs: workspaceTabs, activeTabId, openTab } = useWorkspaceStore();
  const { data: stats, isError: statsError } = useStats();
  const syncStatus = useVaultEvents();

  const view =
    forceView ?? resolveCodexView(pathname, workspaceTabs, activeTabId);

  const onNav = (target: CodexView) => {
    if (target === "atrium") navigate({ to: "/" });
    else if (target === "gazetteer") navigate({ to: "/gazetteer" });
    else if (target === "academic") navigate({ to: "/academic" });
    else if (target === "bases") navigate({ to: "/bases" });
    else if (target === "docs") {
      navigate({
        to: "/docs/$slug",
        params: { slug: DEFAULT_DOC_SLUG },
      });
    } else if (target === "constellation") {
      openTab("graph");
      navigate({ to: "/workspace" });
    } else if (target === "tasking") navigate({ to: "/tasking" });
    else if (target === "folio") {
      const store = useWorkspaceStore.getState();
      const firstPage = workspaceTabs.find((t) => t.type === "page");
      // With no folio open, drop focus off any lingering graph tab so the
      // workspace shows the FolioLauncher empty state rather than the graph.
      if (firstPage) store.activateTab(firstPage.id);
      else store.clearActiveTab();
      navigate({ to: "/workspace" });
    }
  };

  const folioCode = useFolioCode(view);
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
      <header className="order-0 flex h-8 flex-shrink-0 items-stretch border-b border-rule text-[11px]">
        <button
          type="button"
          onClick={() => navigate({ to: "/" })}
          className="flex flex-shrink-0 cursor-pointer items-center border-r border-rule px-3 font-sans text-[15px] font-black uppercase tracking-[0.08em] text-ink"
          aria-label="CLEPSYDRA — return to Atrium"
        >
          <span className="text-accent">C</span>LEPSYDRA
        </button>

        <nav aria-label="Primary navigation" className="flex items-stretch">
          {NAV.map(([key, label], i) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onNav(key)}
                className={cn(
                  "cl-mono flex cursor-pointer items-center gap-1.5 border-r border-rule-soft px-3 uppercase tracking-[0.18em]",
                  active
                    ? "text-ink shadow-[inset_0_-2px_0_0_var(--accent)]"
                    : "text-ink-mute hover:text-ink",
                )}
              >
                <span className="text-[9px] text-ink-mute">{pad2(i)}</span>
                <span className="text-[10px]">{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* HEADER META — minimal status that survives diegetic-off */}
        <div className="cl-mono flex items-stretch text-[10px]">
          <span className="hidden items-center gap-1.5 border-l border-rule-soft px-3 sm:flex">
            <span
              className="inline-block h-[6px] w-[6px]"
              style={{ background: syncColor }}
              aria-hidden
            />
            <span className="text-ink-mute uppercase tracking-[0.16em]">
              {pages} notes
            </span>
          </span>
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
            onClick={() => openSettings("appearance")}
            className={cn(
              "cl-mono flex cursor-pointer items-center gap-1.5 border-l border-rule-soft px-3 uppercase tracking-[0.18em]",
              settingsOpen
                ? "text-ink shadow-[inset_0_-2px_0_0_var(--accent)]"
                : "text-ink-mute hover:text-ink",
            )}
          >
            <span className="text-[9px] text-ink-mute">08</span>
            <span className="text-[10px]">STATUS</span>
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

      {/* ── SHEAF — hidden on ATRIUM, CONSTELLATION, and DOCS ──────── */}
      {view !== "atrium" &&
        view !== "academic" &&
        view !== "bases" &&
        view !== "constellation" &&
        view !== "docs" && (
          <Sheaf activeTabId={activeTabId} className="order-1" />
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
                FILE {folioCode} · VIEW {view.toUpperCase()} · CORPUS {pages}/
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

/* helpers --------------------------------------------------------------- */

function useFolioCode(view: CodexView): string {
  const { tabs, activeTabId } = useWorkspaceStore();
  if (view === "atrium") return "ATRIUM";
  if (view === "constellation") return "GRAPH";
  if (view === "gazetteer") return "INDEX";
  if (view === "tasking") return "TASKING";
  if (view === "academic") return "ACADEMIC";
  if (view === "bases") return "BASES";
  if (view === "docs") return "DOC-001";
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active?.path) return "—";
  return shortFolio(active.path);
}

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
