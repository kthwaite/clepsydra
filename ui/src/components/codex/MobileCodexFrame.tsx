import { useNavigate } from "@tanstack/react-router";
import {
  Columns3,
  Files,
  ListChecks,
  type LucideIcon,
  Plus,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import type { CodexFrameChromeProps } from "#/components/codex/CodexFrame";
import { OpenPagesSheet } from "#/components/codex/OpenPagesSheet";
import { StatusDot } from "#/components/codex/StatusDot";
import { useCodexView } from "#/components/codex/useCodexView";
import {
  goToView,
  MOBILE_BAR,
  type MobileSlot,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { IconButton } from "#/components/ui/icon-button";
import {
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

const SLOT_ICON: Partial<Record<MobileSlot, LucideIcon>> = {
  atrium: Sun,
  agenda: ListChecks,
  tasking: Columns3,
  search: Search,
  folio: Files,
};

/** The mobile companion shell (spec §9 Q3): a quiet top bar with the status
 *  dot, and a five-slot bottom bar. */
export function MobileCodexFrame({
  bottomSlot,
  forceView,
}: CodexFrameChromeProps) {
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openSearch);
  const isSearchOpen = useUiStore((state) => state.isSearchOpen);
  const openInscribe = useUiStore((state) => state.openInscribe);
  const openSettings = useUiStore((state) => state.openSettings);
  const resolved = useCodexView();
  const view = forceView ?? resolved;
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const pageCount = useWorkspaceStore(
    (s) => s.tabs.filter((tab) => tab.type === "page").length,
  );
  const [pagesOpen, setPagesOpen] = useState(false);
  const root = VIEW_REGISTRY[view].navRoot;

  const press = (slot: MobileSlot) => {
    if (slot === "search") openSearch();
    else if (slot === "folio") setPagesOpen(true);
    else goToView(slot, { navigate, openTab, activateTab, leaveWorkspace });
  };

  return (
    <>
      {/* Folio carries its own page bar (MobileFolioLayout). */}
      {view !== "folio" && (
        <header className="cl-mobile-top order-0 flex h-14 min-w-0 flex-shrink-0 items-center gap-2.5 bg-ground pr-2.5 pl-5">
          {view === "atrium" && (
            <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
              <img
                src={`${import.meta.env.BASE_URL}favicon.svg`}
                alt=""
                className="h-[22px] w-[22px] rounded-[6px]"
              />
              <span className="font-serif text-[21px] leading-none text-ink">
                Clepsydra
              </span>
            </span>
          )}
          <span className="flex-1" />
          <fieldset className="m-0 flex min-w-0 shrink-0 items-center border-0 p-0">
            <legend className="sr-only">Global actions</legend>
            <StatusDot />
            <IconButton
              aria-label="New note"
              onPress={openInscribe}
              className="h-11 w-11 text-mute"
            >
              <Plus />
            </IconButton>
            <IconButton
              aria-label="Settings"
              onPress={() => openSettings("appearance")}
              className="h-11 w-11 text-mute"
            >
              <Settings />
            </IconButton>
          </fieldset>
        </header>
      )}

      {bottomSlot
        ? createPortal(
            <nav
              aria-label="Mobile roots"
              className="cl-mobile-bottom order-3 grid flex-shrink-0 grid-cols-5 bg-sink px-2 pt-2"
            >
              {MOBILE_BAR.map((slot) => {
                const Icon = SLOT_ICON[slot] ?? Search;
                const label =
                  slot === "search"
                    ? "Search"
                    : (VIEW_REGISTRY[slot].mobile?.label ?? slot);
                const current = slot !== "search" && root === slot;
                const lit = current || (slot === "search" && isSearchOpen);
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => press(slot)}
                    aria-current={current ? "page" : undefined}
                    {...slotAria(slot, pageCount, isSearchOpen)}
                    className={cn(
                      "flex min-h-12 flex-col items-center gap-1 rounded-lg text-[11.5px]",
                      lit ? "font-medium text-accent" : "text-mute",
                      FOCUS_RING_NATIVE,
                    )}
                  >
                    {slot === "folio" ? (
                      <FolioIcon count={pageCount} lit={lit}>
                        <Icon aria-hidden size={22} strokeWidth={1.7} />
                      </FolioIcon>
                    ) : (
                      <Icon aria-hidden size={22} strokeWidth={1.7} />
                    )}
                    {label}
                  </button>
                );
              })}
            </nav>,
            bottomSlot,
          )
        : null}
      <OpenPagesSheet isOpen={pagesOpen} onOpenChange={setPagesOpen} />
    </>
  );
}

function slotAria(slot: MobileSlot, pageCount: number, searchOpen: boolean) {
  if (slot === "search") return { "aria-expanded": searchOpen };
  if (slot === "folio")
    return {
      "aria-haspopup": "dialog" as const,
      "aria-label": pageCount
        ? `Folio, ${pageCount} open ${pageCount === 1 ? "page" : "pages"}`
        : "Folio",
    };
  return {};
}

function FolioIcon({
  count,
  lit,
  children,
}: {
  count: number;
  lit: boolean;
  children: ReactNode;
}) {
  return (
    <span className="relative block h-[22px] w-[22px]">
      {children}
      {count > 0 && (
        <span
          aria-hidden
          className={cn(
            "absolute -top-1.5 -right-2 h-4 min-w-4 rounded-full px-1 text-center text-[11.5px] leading-4 text-ground",
            lit ? "bg-accent" : "bg-ink",
          )}
        >
          {count}
        </span>
      )}
    </span>
  );
}
