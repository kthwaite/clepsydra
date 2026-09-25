import { useNavigate } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { CodexFrameChromeProps } from "#/components/codex/CodexFrame";
import { ContentsMenu } from "#/components/codex/ContentsMenu";
import { Sheaf } from "#/components/codex/Sheaf";
import { ShellFooter } from "#/components/codex/ShellFooter";
import { type CodexView, useCodexView } from "#/components/codex/useCodexView";
import {
  CORE_NAV,
  goToView,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import {
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { useUiStore } from "#/store/ui";
import { useViewHistory } from "#/store/viewHistory";
import { useWorkspaceStore } from "#/store/workspace";

function ActiveDot() {
  return (
    <span
      aria-hidden
      className="absolute -bottom-2.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent"
    />
  );
}

/** Desktop shell (spec §5.1): wordmark home, the core three, Contents,
 *  Settings; the Sheaf where a view shows it; the simplified footer. */
export function DesktopCodexFrame({
  bottomSlot,
  forceView,
}: CodexFrameChromeProps) {
  const navigate = useNavigate();
  const openSettings = useUiStore((s) => s.openSettings);
  const contentsOpen = useUiStore((s) => s.isContentsOpen);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const record = useViewHistory((s) => s.record);
  const headerRef = useRef<HTMLElement>(null);

  const resolved = useCodexView();
  const view = forceView ?? resolved;
  const descriptor = VIEW_REGISTRY[view];
  const home = descriptor.navRoot === "atrium";
  const go = (target: CodexView) =>
    goToView(target, { navigate, openTab, activateTab, leaveWorkspace });

  useEffect(() => record(view), [record, view]);

  return (
    <>
      <header
        ref={headerRef}
        className="order-0 flex h-[72px] min-w-0 flex-shrink-0 items-center gap-10 px-10"
      >
        <button
          type="button"
          onClick={() => go("atrium")}
          aria-label="Clepsydra — Atrium (home)"
          aria-current={home ? "page" : undefined}
          className="relative flex flex-shrink-0 cursor-pointer items-center gap-2.5"
        >
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            className="h-7 w-7 rounded-[7px]"
          />
          <span className="font-serif text-[24px] leading-none text-ink">
            Clepsydra
          </span>
          {home && <ActiveDot />}
        </button>

        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 items-center gap-7"
        >
          {CORE_NAV.map((key) => {
            const active = descriptor.navRoot === key;
            return (
              <button
                key={key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => go(key)}
                className={cn(
                  "relative shrink-0 cursor-pointer text-[14px]",
                  active ? "font-medium text-ink" : "text-mute hover:text-ink",
                )}
              >
                {VIEW_REGISTRY[key].label}
                {active && <ActiveDot />}
              </button>
            );
          })}
          <ContentsMenu view={view} onGo={go} anchorRef={headerRef} />
        </nav>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => openSettings()}
          aria-label="Settings"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-mute hover:bg-sink hover:text-ink"
        >
          <Settings aria-hidden className="h-[18px] w-[18px]" />
        </button>
      </header>

      {contentsOpen && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 bottom-0 top-[72px] z-40 bg-scrim"
        />
      )}

      {descriptor.showsSheaf && (
        <Sheaf
          activeTabId={activeTabId}
          activeTabVisible={view === "folio"}
          className="order-1"
        />
      )}

      {bottomSlot
        ? createPortal(<ShellFooter view={view} />, bottomSlot)
        : null}
    </>
  );
}
