import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useStats } from "#/api/index";
import { shortFolio } from "#/components/codex/folio-utils";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { useTheme } from "#/components/ThemeProvider";
import { useVaultEvents } from "#/hooks/useVaultEvents";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

type View = "atrium" | "diurnal" | "folio" | "constellation" | "gazetteer";

const TABS: ReadonlyArray<readonly [View, string, string]> = [
  ["atrium", "Atrium", "/"],
  ["diurnal", "Diurnal", "/journal"],
  ["folio", "Folio", "/workspace"],
  ["constellation", "Constellation", "/workspace"],
  ["gazetteer", "Gazetteer", "/gazetteer"],
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
  const { resolvedTheme, toggle } = useTheme();
  const dark = resolvedTheme === "dark";
  const { tabs: workspaceTabs, activeTabId, openTab } = useWorkspaceStore();
  const { data: stats } = useStats();
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

  const onTabClick = (target: View) => {
    if (target === "atrium") navigate({ to: "/" });
    else if (target === "diurnal") navigate({ to: "/journal" });
    else if (target === "gazetteer") navigate({ to: "/gazetteer" });
    else if (target === "constellation") {
      openTab("graph");
      navigate({ to: "/workspace" });
    } else if (target === "folio") {
      const firstPage = workspaceTabs.find((t) => t.type === "page");
      if (firstPage) {
        useWorkspaceStore.getState().activateTab(firstPage.id);
      }
      navigate({ to: "/workspace" });
    }
  };

  const folioCode = useFolioCode(view);
  const plateCode = PLATE_CODES[view];
  const pathLabel = useMemo(
    () => buildPathLabel(view, location.pathname, workspaceTabs, activeTabId),
    [view, location.pathname, workspaceTabs, activeTabId],
  );
  const clock = useClock();

  const totalEntries = stats?.pages ?? 0;
  const totalLinks = stats?.links_total ?? 0;

  return (
    <div className="cl-root cl-paper flex h-screen w-screen flex-col overflow-hidden">
      {/* TOP STATUS BAR */}
      <div className="cl-mono flex flex-shrink-0 border-b-2 border-rule text-[11px]">
        <div className="border-r-2 border-rule bg-bar-bg px-3 py-1 font-serif-sc font-bold uppercase tracking-[0.18em] text-bar-fg">
          ❦ CLEPSYDRA
        </div>
        <div className="border-r border-rule-soft px-3 py-1 text-ink-mute">
          fol. {folioCode}
        </div>
        <div className="border-r border-rule-soft px-3 py-1">
          ~/codex/<span className="text-accent-deep">{pathLabel}</span>
        </div>
        <div className="hidden border-r border-rule-soft px-3 py-1 text-ink-mute md:block">
          vol. iv · clean · {totalEntries} ent.
        </div>
        <div className="flex-1" />
        <div className="hidden border-l border-rule-soft px-3 py-1 text-ink-mute sm:block">
          {plateCode}
        </div>
        <div className="border-l border-rule-soft px-3 py-1">{clock}</div>
        <button
          type="button"
          onClick={toggle}
          className="cursor-pointer border-l border-rule-soft px-3 py-1 font-semibold tracking-[0.14em] text-accent-deep"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          [{dark ? "NCT" : "LUX"}]
        </button>
      </div>

      {/* TAB BAR */}
      <div className="flex flex-shrink-0 border-b border-rule text-[10px]">
        {TABS.map(([k, label], i) => {
          const active = view === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onTabClick(k)}
              className={`cursor-pointer border-r border-rule-soft px-3 py-[3px] font-serif-sc font-semibold uppercase tracking-[0.20em] ${
                active ? "bg-accent text-paper" : "text-ink"
              }`}
            >
              {String(i + 1).padStart(2, "0")} · {label}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          type="button"
          onClick={openSearch}
          className="cl-mono flex cursor-pointer items-center border-l border-rule-soft px-3 py-[3px] text-ink-mute"
        >
          <span className="text-accent">$</span>
          <span className="ml-1">invoke</span>
          <span className="ml-2 border-l border-rule-soft pl-2 text-[9px]">⌘K</span>
        </button>
      </div>

      {/* BODY */}
      <div className="cl-noscroll relative flex-1 overflow-auto">{children}</div>

      {/* READING PROGRESS — only on folio */}
      {view === "folio" && (
        <div className="relative h-[2px] flex-shrink-0 bg-rule-soft">
          <div
            className="absolute inset-0 bg-accent transition-[width] duration-100 ease-linear"
            style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
          />
        </div>
      )}

      {/* BOTTOM STATUS BAR */}
      <div className="cl-mono flex flex-shrink-0 border-t-2 border-rule bg-bar-bg text-[10px] text-bar-fg">
        <span className="border-r border-bar-rule px-3 py-[2px] font-bold tracking-[0.16em]">
          READ
        </span>
        <span className="border-r border-bar-rule px-3 py-[2px] opacity-70">UTF-8</span>
        {view === "folio" ? (
          <>
            <span className="border-r border-bar-rule px-3 py-[2px]">
              {Math.round(Math.max(0, Math.min(1, progress)) * 100)}%
            </span>
            <span className="px-3 py-[2px] opacity-70">
              ≈ {Math.max(1, Math.round((1 - progress) * 8))} min remaining
            </span>
          </>
        ) : (
          <span className="px-3 py-[2px] opacity-70">
            idx ✓ · sync{" "}
            {syncStatus === "connected" ? "✓" : syncStatus === "connecting" ? "…" : "✗"} · agent ·
            idle
          </span>
        )}
        <span className="flex-1" />
        <span className="hidden px-3 py-[2px] opacity-70 md:inline">
          {totalEntries} ent · {totalLinks} xref
        </span>
        <span className="border-l border-bar-rule px-3 py-[2px]">
          last collated {clock} GMT
        </span>
      </div>
    </div>
  );
}

/* helpers --------------------------------------------------------------- */

const PLATE_CODES: Record<View, string> = {
  atrium: "PL. I",
  diurnal: "PL. XII",
  folio: "PL. V",
  constellation: "PL. V",
  gazetteer: "PL. ∞",
};

function useFolioCode(view: View): string {
  const { tabs, activeTabId } = useWorkspaceStore();
  if (view === "atrium") return "I·i";
  if (view === "diurnal") return "XII·iv";
  if (view === "constellation") return "V·v";
  if (view === "gazetteer") return "∞";
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active?.path) return "V·iii";
  return shortFolio(active.path);
}

function buildPathLabel(
  view: View,
  pathname: string,
  tabs: ReturnType<typeof useWorkspaceStore.getState>["tabs"],
  activeTabId: string | null,
): string {
  if (view === "folio") {
    const t = tabs.find((x) => x.id === activeTabId);
    if (t?.path) return t.path.replace(/\.md$/, "");
  }
  if (view === "constellation") return "graph";
  if (view === "atrium") return "atrium";
  if (view === "diurnal") return "diurnal";
  if (view === "gazetteer") return "gazetteer";
  return pathname.replace(/^\//, "") || "atrium";
}

function useClock(): string {
  const [t, setT] = useState(() => fmtClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setT(fmtClock(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

function fmtClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
