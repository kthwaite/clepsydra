import { useNavigate } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import type { CodexFrameChromeProps } from "#/components/codex/CodexFrame";
import { useCodexView } from "#/components/codex/useCodexView";
import {
  enabledNavItems,
  goToView,
  MOBILE_NAV,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";
import { useTheme } from "#/components/ThemeProvider";
import {
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { useUiStore } from "#/store/ui";

export function MobileCodexFrame({
  bottomSlot,
  forceView,
}: CodexFrameChromeProps) {
  const features = useFeatureFlags();
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openSearch);
  const openInscribe = useUiStore((state) => state.openInscribe);
  const openSettings = useUiStore((state) => state.openSettings);
  const { toggle, resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const resolved = useCodexView();
  const view = forceView ?? resolved;
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const navItems = enabledNavItems(MOBILE_NAV, features);

  return (
    <>
      <header className="cl-mobile-top order-0 flex min-w-0 flex-shrink-0 items-stretch border-b border-rule bg-paper">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap px-3 py-2 font-sans text-sm font-black uppercase tracking-[0.08em] text-ink">
          <span className="text-accent">C</span>LEPSYDRA
        </div>
        <fieldset className="m-0 flex min-w-0 shrink-0 items-stretch border-0 p-0">
          <legend className="sr-only">Global actions</legend>
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
        </fieldset>
      </header>

      {bottomSlot
        ? createPortal(
            <nav
              aria-label="Mobile roots"
              className="cl-mobile-bottom order-3 flex flex-shrink-0 border-t border-rule bg-bar-bg"
            >
              {navItems.map((root) => {
                const { mobile } = VIEW_REGISTRY[root];
                if (!mobile) return null;
                const active = VIEW_REGISTRY[view].navRoot === root;
                return (
                  <button
                    key={root}
                    type="button"
                    onClick={() =>
                      goToView(root, {
                        navigate,
                        openTab,
                        activateTab,
                        leaveWorkspace,
                      })
                    }
                    aria-label={mobile.name}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "cl-mono min-h-12 flex-1 px-2 py-2 text-[10px] uppercase tracking-[0.12em]",
                      active
                        ? "text-bar-fg shadow-[inset_0_2px_0_0_var(--accent)]"
                        : "text-bar-fg/65",
                    )}
                  >
                    {mobile.label}
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
