import { useNavigate } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import type { CodexFrameChromeProps } from "#/components/codex/CodexFrame";
import {
  type CodexView,
  resolveCodexView,
} from "#/components/codex/useCodexView";
import { useTheme } from "#/components/ThemeProvider";
import { cn } from "#/lib/cn";
import { useUiStore } from "#/store/ui";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

type MobileRoot = Extract<
  CodexView,
  "atrium" | "gazetteer" | "academic" | "bases" | "feeds" | "constellation"
>;

const ROOTS: ReadonlyArray<
  readonly [MobileRoot, accessibleName: string, visualLabel: string]
> = [
  ["atrium", "Atrium", "ATR"],
  ["gazetteer", "Gazetteer", "GAZ"],
  ["academic", "Academic", "ACAD"],
  ["bases", "Bases", "BASE"],
  ["feeds", "Feeds", "FEED"],
  ["constellation", "Constellation", "GRAPH"],
];

export function MobileCodexFrame({
  bottomSlot,
  forceView,
  pathname,
}: CodexFrameChromeProps) {
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openSearch);
  const openInscribe = useUiStore((state) => state.openInscribe);
  const openSettings = useUiStore((state) => state.openSettings);
  const { toggle, resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const { tabs, activeTabId, openTab } = useWorkspaceStore();
  const view = forceView ?? resolveCodexView(pathname, tabs, activeTabId);

  const navigateToRoot = (root: MobileRoot) => {
    if (root === "atrium") {
      navigate({ to: "/" });
    } else if (root === "gazetteer") {
      navigate({ to: "/gazetteer", search: { sort: "ts", page: 1 } });
    } else if (root === "academic") {
      navigate({ to: "/academic" });
    } else if (root === "bases") {
      navigate({ to: "/bases" });
    } else if (root === "feeds") {
      navigate({ to: "/feeds" } as never);
    } else {
      runWorkspaceTransition(() => {
        openTab("graph");
        void navigate({ to: "/workspace" });
      });
    }
  };

  return (
    <>
      <header className="cl-mobile-top order-0 flex min-w-0 flex-shrink-0 items-stretch border-b border-rule bg-paper">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap px-3 py-2 font-sans text-sm font-black uppercase tracking-[0.08em] text-ink">
          <span className="text-accent">C</span>LEPSYDRA
        </div>
        <div
          role="group"
          aria-label="Global actions"
          className="flex shrink-0 items-stretch"
        >
          <button
            type="button"
            onClick={openSearch}
            className="cl-mono min-h-11 min-w-8 border-l border-rule-soft px-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute"
            aria-label="Search"
          >
            ⌕
          </button>
          <button
            type="button"
            onClick={openInscribe}
            className="cl-mono min-h-11 min-w-8 border-l border-rule-soft px-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute"
            aria-label="New note"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => openSettings("appearance")}
            className="cl-mono min-h-11 min-w-8 border-l border-rule-soft px-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute"
            aria-label="Status"
          >
            ST
          </button>
          <button
            type="button"
            onClick={toggle}
            className="cl-mono min-h-11 min-w-8 border-l border-rule-soft px-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute"
            aria-label={dark ? "Switch to paper mode" : "Switch to dark mode"}
            title={dark ? "Switch to paper mode" : "Switch to dark mode"}
          >
            {dark ? "P" : "D"}
          </button>
        </div>
      </header>

      {bottomSlot
        ? createPortal(
            <nav
              aria-label="Mobile roots"
              className="cl-mobile-bottom order-3 flex flex-shrink-0 border-t border-rule bg-bar-bg"
            >
              {ROOTS.map(([root, accessibleName, visualLabel]) => {
                const active = view === root;
                return (
                  <button
                    key={root}
                    type="button"
                    onClick={() => navigateToRoot(root)}
                    aria-label={accessibleName}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "cl-mono min-h-12 flex-1 px-2 py-2 text-[10px] uppercase tracking-[0.12em]",
                      active
                        ? "text-bar-fg shadow-[inset_0_2px_0_0_var(--accent)]"
                        : "text-bar-fg/65",
                    )}
                  >
                    {visualLabel}
                  </button>
                );
              })}
            </nav>,
            bottomSlot,
          )
        : null}
    </>
  );
}
