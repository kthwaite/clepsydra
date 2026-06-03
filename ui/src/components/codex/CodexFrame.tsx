import { useIsMutating } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useStats } from "#/api/index";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { shortFolio } from "#/components/codex/folio-utils";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { Sheaf } from "#/components/codex/Sheaf";
import { useTheme } from "#/components/ThemeProvider";
import { useUptime } from "#/hooks/useUptime";
import { useVaultEvents } from "#/hooks/useVaultEvents";
import { cn } from "#/lib/cn";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

type View = "atrium" | "folio" | "gazetteer" | "constellation" | "diurnal";

/** Nav order + diegetic index numbers. */
const NAV: ReadonlyArray<readonly [View, string]> = [
  ["atrium", "ATRIUM"],
  ["folio", "FOLIO"],
  ["gazetteer", "GAZETTEER"],
  ["constellation", "CONSTELLATION"],
  ["diurnal", "DIURNAL"],
];

type CodexFrameProps = {
  children: ReactNode;
  /** override automatic view detection; usually unnecessary */
  forceView?: View;
};

export function CodexFrame({ children, forceView }: CodexFrameProps) {
  const { progress } = useReadingProgress();
  const location = useLocation();
  const navigate = useNavigate();
  const openSearch = useUiStore((s) => s.openSearch);
  const openSettings = useUiStore((s) => s.openSettings);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const settingsOpen = useUiStore((s) => s.isSettingsOpen);
  const { toggle, resolvedTheme, diegetic } = useTheme();
  const dark = resolvedTheme === "dark";
  const { tabs: workspaceTabs, activeTabId, openTab } = useWorkspaceStore();
  const { data: stats, isError: statsError } = useStats();
  const syncStatus = useVaultEvents();

  const view: View = useMemo(() => {
    if (forceView) return forceView;
    const p = location.pathname;
    if (p === "/" || p === "") return "atrium";
    if (p.startsWith("/journal")) return "diurnal";
    if (p.startsWith("/gazetteer")) return "gazetteer";
    if (p.startsWith("/workspace")) {
      const active = workspaceTabs.find((t) => t.id === activeTabId);
      return active?.type === "graph" ? "constellation" : "folio";
    }
    return "atrium";
  }, [forceView, location.pathname, workspaceTabs, activeTabId]);

  const onNav = (target: View) => {
    if (target === "atrium") navigate({ to: "/" });
    else if (target === "diurnal") navigate({ to: "/journal" });
    else if (target === "gazetteer") navigate({ to: "/gazetteer" });
    else if (target === "constellation") {
      openTab("graph");
      navigate({ to: "/workspace" });
    } else if (target === "folio") {
      const firstPage = workspaceTabs.find((t) => t.type === "page");
      if (firstPage) useWorkspaceStore.getState().activateTab(firstPage.id);
      navigate({ to: "/workspace" });
    }
  };

  const folioCode = useFolioCode(view);
  const clock = useUtcClock();
  const uptime = useUptime();
  const writing = useIsMutating() > 0;

  // ⌘N → INTAKE (browsers reserve ⌘N for new-window in some cases; the command
  // palette offers a reliable fallback).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        openInscribe();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openInscribe]);

  const pages = stats?.pages ?? 0;
  const links = stats?.links_total ?? 0;
  const sync = syncStatus === "connected";
  const syncColor = sync
    ? "var(--cool)"
    : syncStatus === "connecting"
      ? "var(--warn)"
      : "var(--hot)";

  return (
    <div className="cl-root cl-paper flex h-screen w-screen flex-col overflow-hidden">
      {/* ── HEADER RAIL ─────────────────────────────────────────────── */}
      <header className="flex flex-shrink-0 items-stretch border-b border-rule text-[11px] h-8">
        <button
          type="button"
          onClick={() => navigate({ to: "/" })}
          className="flex flex-shrink-0 cursor-pointer items-center border-r border-rule px-3 font-sans text-[15px] font-black uppercase tracking-[0.08em] text-ink"
          aria-label="CLEPSYDRA — return to Atrium"
        >
          <span className="text-accent">C</span>LEPSYDRA
        </button>

        <nav className="flex items-stretch">
          {NAV.map(([key, label], i) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onNav(key)}
                className={cn(
                  "cl-mono flex cursor-pointer items-center gap-1.5 border-r border-rule-soft px-3 uppercase tracking-[0.18em]",
                  active
                    ? "text-ink shadow-[inset_0_-2px_0_0_var(--accent)]"
                    : "text-ink-mute hover:text-ink",
                )}
              >
                <span className="text-[9px] text-ink-mute">
                  {String(i).padStart(2, "0")}
                </span>
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
            <span className="text-[9px] text-ink-mute">05</span>
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

      {/* ── SHEAF (open files) — hidden on ATRIUM + CONSTELLATION ───── */}
      {view !== "atrium" && view !== "constellation" && (
        <Sheaf activeTabId={activeTabId} />
      )}

      {/* READING PROGRESS — folio only; sits directly under the tab bar */}
      {view === "folio" && (
        <div className="relative h-[2px] flex-shrink-0 bg-rule-soft">
          <div
            className="absolute inset-0 bg-accent transition-[width] duration-100 ease-linear"
            style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
          />
        </div>
      )}

      {/* ── WORKSPACE ───────────────────────────────────────────────── */}
      <main className="cl-noscroll relative flex-1 overflow-auto">
        <div key={location.pathname} className="view-anim h-full">
          {children}
        </div>
      </main>

      {/* ── FOOTER RAIL ─────────────────────────────────────────────── */}
      <footer className="cl-mono flex flex-shrink-0 items-center border-t border-rule bg-bar-bg text-[10px] text-bar-fg">
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
          FILE {folioCode} · VIEW {view.toUpperCase()} · CORPUS {pages}/{links}
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
        <span className="flex-shrink-0 border-l border-bar-rule px-3 py-[2px] tabular-nums opacity-70">
          up {uptime}
        </span>
        <span className="flex-shrink-0 border-l border-bar-rule px-3 py-[2px] tabular-nums">
          {clock} UTC
        </span>
      </footer>
    </div>
  );
}

/* helpers --------------------------------------------------------------- */

function useFolioCode(view: View): string {
  const { tabs, activeTabId } = useWorkspaceStore();
  if (view === "atrium") return "ATRIUM";
  if (view === "diurnal") return "DIURNAL";
  if (view === "constellation") return "GRAPH";
  if (view === "gazetteer") return "INDEX";
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active?.path) return "—";
  return shortFolio(active.path);
}

function useUtcClock(): string {
  const [t, setT] = useState(() => fmtClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setT(fmtClock(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

function fmtClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
