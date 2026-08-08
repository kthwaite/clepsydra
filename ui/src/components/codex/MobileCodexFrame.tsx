import { useLocation, useNavigate } from "@tanstack/react-router";
import type { CodexFrameProps } from "#/components/codex/CodexFrame";
import {
  type CodexView,
  resolveCodexView,
} from "#/components/codex/useCodexView";
import { cn } from "#/lib/cn";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

type MobileRoot = Extract<
  CodexView,
  "atrium" | "gazetteer" | "constellation"
>;

const ROOTS: ReadonlyArray<readonly [MobileRoot, string]> = [
  ["atrium", "Atrium"],
  ["gazetteer", "Gazetteer"],
  ["constellation", "Constellation"],
];

export function MobileCodexFrame({ children, forceView }: CodexFrameProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openSearch);
  const openInscribe = useUiStore((state) => state.openInscribe);
  const { tabs, activeTabId, openTab } = useWorkspaceStore();
  const view =
    forceView ?? resolveCodexView(location.pathname, tabs, activeTabId);

  const navigateToRoot = (root: MobileRoot) => {
    if (root === "atrium") {
      navigate({ to: "/" });
    } else if (root === "gazetteer") {
      navigate({ to: "/gazetteer" });
    } else {
      openTab("graph");
      navigate({ to: "/workspace" });
    }
  };

  return (
    <div className="cl-root cl-paper flex h-dvh w-screen flex-col overflow-hidden">
      <header className="cl-mobile-top flex flex-shrink-0 items-stretch border-b border-rule bg-paper">
        <div className="flex flex-1 items-center px-3 py-2 font-sans text-sm font-black uppercase tracking-[0.08em] text-ink">
          <span className="text-accent">C</span>LEPSYDRA
        </div>
        <button
          type="button"
          onClick={openSearch}
          className="cl-mono min-h-11 border-l border-rule-soft px-3 text-[10px] uppercase tracking-[0.16em] text-ink-mute"
          aria-label="Search"
        >
          Search
        </button>
        <button
          type="button"
          onClick={openInscribe}
          className="cl-mono min-h-11 border-l border-rule-soft px-3 text-[10px] uppercase tracking-[0.16em] text-ink-mute"
          aria-label="New note"
        >
          New note
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div key={location.pathname} className="view-anim min-h-full">
          {children}
        </div>
      </main>

      <nav
        aria-label="Mobile roots"
        className="cl-mobile-bottom flex flex-shrink-0 border-t border-rule bg-bar-bg"
      >
        {ROOTS.map(([root, label]) => {
          const active = view === root;
          return (
            <button
              key={root}
              type="button"
              onClick={() => navigateToRoot(root)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "cl-mono min-h-12 flex-1 px-2 py-2 text-[10px] uppercase tracking-[0.12em]",
                active
                  ? "text-bar-fg shadow-[inset_0_2px_0_0_var(--accent)]"
                  : "text-bar-fg/65",
              )}
            >
              {label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
